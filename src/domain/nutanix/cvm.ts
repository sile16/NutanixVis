/**
 * Controller VM (SPEC §6.2). Hosts `CvmComponent`s and delegates its hooks to them, in order:
 * the storage backend (E or G), Stargate, the Zookeeper member, the Cassandra node and the
 * Acropolis worker. Power: off → booting (`cluster.cvmBootS`) → running. It boots after
 * power-on, recovery or a reboot, and only then is Stargate up (`stargate.up`).
 *
 * T1: while running, Hades (`./hades.ts`) may put the node in maintenance mode when the CVM has
 * lost its service volumes. Its services then stop (`running()` is false, as for a CVM that is
 * down) while the storage backend keeps reconnecting; after a successful re-map the services
 * restart with `cluster.cvmBootS` settling.
 */

import { asEngineContext } from '../../engine/context';
import type {
  Device,
  DeviceStatus,
  DeviceView,
  Message,
  TimerHandle,
  ViewField,
} from '../../engine/types';
import type { KnownCitationId } from '../citations';
import type { Ctx, CvmComponent, StorageBackend } from '../contracts';
import type { Profile } from '../versions/profile';
import type { CvmFacts } from './facts';
import { Hades } from './hades';
import type { Registry } from './registry';
import { AcropolisWorker, CassandraNode, ZkMember } from './services';
import { Stargate } from './stargate';

export type CvmPower = 'off' | 'booting' | 'running';

export class Cvm implements Device<Profile> {
  readonly kind = 'cvm';
  readonly id: string;
  readonly label: string;
  readonly parentId: string;
  readonly stargate: Stargate;
  readonly zk: ZkMember;
  readonly cassandra: CassandraNode;
  readonly hades: Hades;
  private readonly components: readonly CvmComponent[];
  private power: CvmPower = 'running';
  /** Tick its services started (they first ping ZK the tick after). */
  runningSince = 0;
  private engineUp = true;
  private bootTimer: TimerHandle | null = null;
  private rebootRequested = false;
  private stargateCmd: 'stop' | 'start' | null = null;
  private hadesWake: TimerHandle | null = null;
  private stopCause: 'clean-stop' | 'silent' = 'silent';

  constructor(
    readonly facts: CvmFacts,
    private readonly backend: StorageBackend,
    private readonly reg: Registry,
  ) {
    this.id = facts.id;
    this.label = facts.label;
    this.parentId = facts.host;
    this.stargate = new Stargate(facts.id, backend, reg);
    this.zk = new ZkMember(facts.id, reg);
    this.cassandra = new CassandraNode();
    this.hades = new Hades(backend, reg.hadesMaintenanceEnabled());
    this.components = [
      backend,
      this.stargate,
      this.zk,
      this.cassandra,
      new AcropolisWorker(facts.id, facts.host, reg),
    ];
  }

  get hostId(): string {
    return this.facts.host;
  }

  /** Services are running: powered on, booted, and not in Hades maintenance mode. */
  running(): boolean {
    return this.power === 'running' && this.hades.state === 'ok';
  }

  stargateServing(): boolean {
    return this.running() && this.stargate.processUp;
  }

  /**
   * Why Stargate is not serving: `clean-stop` when it was stopped in an orderly way (CVM reboot,
   * `cvm.stop-stargate`, Hades maintenance), `silent` when it died with its CVM or host (power
   * loss, failure); null while it serves. Peers see a clean stop at once (sessions closed).
   */
  stargateDownCause(): 'clean-stop' | 'silent' | null {
    return this.stargateServing() ? null : this.stopCause;
  }

  relinquish(vdisk: string): void {
    this.stargate.relinquish(vdisk);
  }

  requestReboot(): void {
    this.rebootRequested = true;
  }

  requestStargate(cmd: 'stop' | 'start'): void {
    this.stargateCmd = cmd;
  }

  // ── Hooks ───────────────────────────────────────────────────────────────

  preTick(ctx: Ctx): void {
    const hostUp = this.reg.hostAlive(this.hostId);
    if (!hostUp && this.power !== 'off') {
      this.stopCause = 'silent';
      this.goDown(ctx, true);
    } else if (hostUp && this.engineUp && this.power === 'off') this.boot(ctx);
    if (this.rebootRequested) {
      this.rebootRequested = false;
      if (this.power !== 'off') {
        this.stopCause = 'clean-stop';
        this.goDown(ctx, false);
        this.boot(ctx);
      }
    }
    if (this.stargateCmd !== null) this.applyStargateCmd(ctx);
    if (this.power === 'running') this.stepHades(ctx);
    this.each((c) => c.preTick?.(ctx));
  }

  emit(ctx: Ctx): void {
    this.each((c) => c.emit?.(ctx));
  }

  onMessage(msg: Message, ctx: Ctx): void {
    if (this.power !== 'running') return;
    for (const c of this.active()) if (c.onMessage?.(msg, ctx)) break;
    this.stargate.pump(ctx);
  }

  tick(ctx: Ctx): void {
    this.each((c) => c.tick?.(ctx));
  }

  postTick(ctx: Ctx): void {
    this.each((c) => c.postTick?.(ctx));
  }

  onFail(ctx: Ctx): void {
    this.engineUp = false;
    this.stopCause = 'silent';
    if (this.running()) this.failComponents(ctx);
    else if (this.power === 'running') this.backend.onFail?.(ctx);
    this.power = 'off';
    this.bootTimer = null;
    this.hadesWake = null;
    this.hades.reset();
  }

  onRecover(ctx: Ctx): void {
    this.engineUp = true;
    if (this.reg.hostAlive(this.hostId)) this.boot(ctx);
  }

  derived(): Readonly<Record<string, ViewField>> {
    const out: Record<string, ViewField> = {};
    for (const c of this.components) Object.assign(out, c.derived?.() ?? {});
    return out;
  }

  view(): DeviceView {
    const up = this.power !== 'off';
    // `unhealthy`: serving but outside the ZK quorum side. A CVM that just booted is judged from
    // the next quorum evaluation on (it is not in any partition yet).
    const judged = this.reg.partitionOf.has(this.id);
    const stargate = !this.stargateServing()
      ? 'down'
      : !judged || this.reg.inQuorum(this.id)
        ? 'up'
        : 'unhealthy';
    const fields: Record<string, ViewField> = {
      state: up ? 'up' : 'down',
      power: this.power,
      stargate,
      nvmePathsUp: null,
      nvmePathsTotal: null,
      nvmePaths: null,
      zkMember: this.reg.zkMembers.has(this.id),
      zkQuorum: this.running() && this.reg.inQuorum(this.id),
      zkPartition: this.running() ? (this.reg.partitionOf.get(this.id) ?? null) : null,
      ringState: this.cassandra.state,
      ownedVdisks: this.stargate.ownedVdisks(),
      backend: this.backend.kind,
      backendHealth: this.backend.health(),
      // T1: Hades maintenance mode after losing the service volumes (`ok` elsewhere).
      hades: this.hades.state,
    };
    for (const c of this.components) Object.assign(fields, c.viewFields?.() ?? {});
    const badges: string[] = [];
    if (this.reg.zkLeader === this.id) badges.push('zk-leader');
    if (this.reg.zkMembers.has(this.id)) badges.push('zk');
    let status: DeviceStatus = 'healthy';
    if (!up) status = 'offline';
    else if (this.power === 'booting' || stargate !== 'up') status = 'degraded';
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      parent: this.parentId,
      status,
      badges,
      fields,
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * Components that run: all of them while running, except the backend if Stargate stopped. In
   * Hades maintenance only the backend runs (it keeps reconnecting: the re-map proxy).
   */
  private active(): readonly CvmComponent[] {
    if (this.power !== 'running') return [];
    if (this.hades.state !== 'ok') return [this.backend];
    return this.stargate.processUp
      ? this.components
      : this.components.filter((c) => c !== this.backend);
  }

  private each(fn: (c: CvmComponent) => void): void {
    for (const c of this.active()) fn(c);
  }

  private failComponents(ctx: Ctx): void {
    for (const c of this.components) {
      if (c === this.backend && !this.stargate.processUp) continue;
      c.onFail?.(ctx);
    }
  }

  /** Power lost with the host (or a CVM reboot): services stop; endpoints vanish if off. */
  private goDown(ctx: Ctx, withHost: boolean): void {
    if (this.running()) this.failComponents(ctx);
    else if (this.power === 'running') this.backend.onFail?.(ctx);
    this.stargate.setProcess(false);
    if (this.bootTimer) ctx.timers.cancel(this.bootTimer);
    this.bootTimer = null;
    if (this.hadesWake) ctx.timers.cancel(this.hadesWake);
    this.hadesWake = null;
    this.hades.reset();
    this.power = 'off';
    if (withHost) this.setEndpoints(ctx, false);
  }

  /** Boot for `cluster.cvmBootS`, then services start and Stargate reports `stargate.up`. */
  private boot(ctx: Ctx): void {
    const B = ctx.profile.cluster.cvmBootS;
    this.setEndpoints(ctx, true);
    this.power = 'booting';
    this.stargate.setProcess(false);
    if (this.bootTimer) ctx.timers.cancel(this.bootTimer);
    this.bootTimer = ctx.timers.set(
      `${this.id} boot`,
      B.value,
      { cite: B.cite, confidence: B.confidence },
      () => {
        this.bootTimer = null;
        this.power = 'running';
        this.runningSince = ctx.now;
        this.stargate.setProcess(true);
        for (const c of this.components) c.onRecover?.(ctx);
        this.emitStargateUp(ctx, `${this.label} booted; Stargate is serving`);
      },
    );
  }

  // ── Hades (T1) ──────────────────────────────────────────────────────────

  private stepHades(ctx: Ctx): void {
    const step = this.hades.step(ctx, this.hades.state !== 'ok' || this.stargate.processUp);
    if (step === 'enter-maintenance') this.enterMaintenance(ctx);
    else if (step === 'remapped') this.restartServices(ctx);
    this.wakeHades(ctx);
  }

  /** Hades: service volumes lost past the threshold → maintenance mode, services stop. */
  private enterMaintenance(ctx: Ctx): void {
    const H = ctx.profile.hades;
    this.stopCause = 'clean-stop';
    this.failComponents(ctx);
    this.stargate.setProcess(false);
    // The CVM's NVMe initiator keeps trying to reach the array (Hades re-maps periodically).
    this.backend.onRecover?.(ctx);
    this.hades.enterMaintenance(ctx.now, ctx);
    const cite: KnownCitationId[] = [
      'ntnx-cmdref-aos-7.6',
      'ntnx-bible-8c',
      'ntnx-pe-alerts-7.0-cluster',
    ];
    ctx.emit({
      severity: 'error',
      deviceId: this.id,
      code: 'hades.maintenance.enter',
      text: `${this.label}: service volumes unreachable for ${H.externalStorageErrorThresholdS.value} s; Hades puts the node in maintenance mode and its services (Stargate, Zookeeper, Cassandra) stop. Prism alerts A3032 "Cluster services are down" and A1030 "Stargate Temporarily Down"`,
      causeIds: this.reg.causes.get(this.id) ?? [],
      cite,
      confidence: H.maintenanceOnStorageError.confidence,
    });
  }

  /** A periodic re-map found the service volumes: services restart (`cvmBootS` settling). */
  private restartServices(ctx: Ctx): void {
    const B = ctx.profile.cluster.cvmBootS;
    const H = ctx.profile.hades.mapNvmfVolumesIntervalS;
    this.hades.beginRestart();
    ctx.emit({
      severity: 'info',
      deviceId: this.id,
      code: 'hades.volumes.remapped',
      text: `${this.label}: Hades re-mapped the NVMf service volumes (every ${H.value} s); CVM services restarting`,
      causeIds: [],
      cite: [...H.cite],
      confidence: H.confidence,
    });
    if (this.bootTimer) ctx.timers.cancel(this.bootTimer);
    this.bootTimer = ctx.timers.set(
      `${this.id} services restart`,
      B.value,
      { cite: B.cite, confidence: B.confidence },
      () => {
        this.bootTimer = null;
        this.hades.reset();
        this.runningSince = ctx.now;
        this.stargate.setProcess(true);
        // The backend kept running through maintenance: it is not restarted.
        for (const c of this.components) if (c !== this.backend) c.onRecover?.(ctx);
        this.emitStargateUp(
          ctx,
          `${this.label}: services restarted after the re-map; Stargate is serving`,
        );
      },
    );
  }

  /** Keep an engine timer at Hades' next decision, so "fast-forward to next timer" stops there. */
  private wakeHades(ctx: Ctx): void {
    const at = this.hades.nextDueAt(ctx);
    if (this.hadesWake && this.hadesWake.dueAt === at) return;
    if (this.hadesWake) ctx.timers.cancel(this.hadesWake);
    this.hadesWake = null;
    if (at === null || at <= ctx.now) return;
    const H = ctx.profile.hades.mapNvmfVolumesIntervalS;
    this.hadesWake = ctx.timers.set(
      `${this.id} hades`,
      at - ctx.now,
      { cite: H.cite, confidence: H.confidence },
      () => {
        this.hadesWake = null;
      },
    );
  }

  private applyStargateCmd(ctx: Ctx): void {
    const cmd = this.stargateCmd;
    this.stargateCmd = null;
    if (!this.running()) return;
    if (cmd === 'stop' && this.stargate.processUp) {
      this.stopCause = 'clean-stop';
      this.backend.onFail?.(ctx);
      this.stargate.setProcess(false);
      ctx.emit({
        severity: 'warn',
        deviceId: this.id,
        code: 'stargate.down',
        text: `${this.label}: Stargate stopped. Prism alert A1030 "Stargate Temporarily Down"`,
        causeIds: this.reg.causes.get(this.id) ?? [],
        cite: ['ntnx-pe-alerts-7.0-cvm'],
      });
    } else if (cmd === 'start' && !this.stargate.processUp) {
      // Stargate start time is not modeled (`assumption`: immediate).
      this.stargate.setProcess(true);
      this.backend.onRecover?.(ctx);
      this.emitStargateUp(ctx, `${this.label}: Stargate started`);
    }
  }

  private emitStargateUp(ctx: Ctx, text: string): void {
    ctx.emit({
      severity: 'info',
      deviceId: this.id,
      code: 'stargate.up',
      text,
      causeIds: [],
      cite: ctx.profile.cluster.cvmBootS.cite,
    });
  }

  private setEndpoints(ctx: Ctx, up: boolean): void {
    const ectx = asEngineContext(ctx);
    for (const e of ectx.net.endpointsOf(this.id)) {
      if (ectx.net.isAdminUp(e.id) !== up) ectx.endpoints.setUp(e.id, up);
    }
  }
}
