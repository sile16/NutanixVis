/**
 * Controller VM (SPEC §6.2). Hosts `CvmComponent`s and delegates its hooks to them, in order:
 * the storage backend (E or G), Stargate, the Zookeeper member, the Cassandra node and the
 * Acropolis worker. Power: off → booting (`cluster.cvmBootS`) → running. It boots after
 * power-on, recovery or a reboot, and only then is Stargate up (`stargate.up`).
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
import type { Ctx, CvmComponent, StorageBackend } from '../contracts';
import type { Profile } from '../versions/profile';
import type { CvmFacts } from './facts';
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
  private readonly components: readonly CvmComponent[];
  private power: CvmPower = 'running';
  /** Tick its services started (they first ping ZK the tick after). */
  runningSince = 0;
  private engineUp = true;
  private bootTimer: TimerHandle | null = null;
  private rebootRequested = false;
  private stargateCmd: 'stop' | 'start' | null = null;

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

  running(): boolean {
    return this.power === 'running';
  }

  stargateServing(): boolean {
    return this.running() && this.stargate.processUp;
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
    if (!hostUp && this.power !== 'off') this.goDown(ctx, true);
    else if (hostUp && this.engineUp && this.power === 'off') this.boot(ctx);
    if (this.rebootRequested) {
      this.rebootRequested = false;
      if (this.power !== 'off') {
        this.goDown(ctx, false);
        this.boot(ctx);
      }
    }
    if (this.stargateCmd !== null) this.applyStargateCmd(ctx);
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
    if (this.power === 'running') this.failComponents(ctx);
    this.power = 'off';
    this.bootTimer = null;
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

  /** Components that run: all of them while running, except the backend if Stargate stopped. */
  private active(): readonly CvmComponent[] {
    if (this.power !== 'running') return [];
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
    if (this.power === 'running') this.failComponents(ctx);
    this.stargate.setProcess(false);
    if (this.bootTimer) ctx.timers.cancel(this.bootTimer);
    this.bootTimer = null;
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

  private applyStargateCmd(ctx: Ctx): void {
    const cmd = this.stargateCmd;
    this.stargateCmd = null;
    if (this.power !== 'running') return;
    if (cmd === 'stop' && this.stargate.processUp) {
      this.backend.onFail?.(ctx);
      this.stargate.setProcess(false);
      ctx.emit({
        severity: 'warn',
        deviceId: this.id,
        code: 'stargate.down',
        text: `${this.label}: Stargate stopped`,
        causeIds: this.reg.causes.get(this.id) ?? [],
        cite: [],
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
