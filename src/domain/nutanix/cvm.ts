/**
 * Controller VM (SPEC §6.2). Hosts `CvmComponent`s and delegates its hooks to them, in order:
 * the storage backend (E or G), Stargate, the Zookeeper member, the Cassandra node and the
 * Acropolis worker. Power: off → booting (`cluster.cvmBootS`) → running. It boots after
 * power-on, recovery or a reboot, and only then is Stargate up (`stargate.up`).
 *
 * T1: while running, Hades (`./hades.ts`) may put the node in maintenance mode when the CVM has
 * lost its service volumes. Its services then stop (`running()` is false, as for a CVM that is
 * down) while the storage backend keeps reconnecting; once a volume check finds the mounts
 * healthy again the node leaves maintenance and the services restart (`hades.servicesRestartS`).
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

/**
 * A Stargate outage as initiators and peer Stargates see it (SPEC §6.2 "iSCSI redirector"):
 * - `resetAt`: when its iSCSI connections were reset (orderly stop, process exit, CVM reboot,
 *   ZK session loss on a live CVM). Initiators notice a reset at once; with `null` the Stargate
 *   went silent (power loss, hang) and only their NOPs notice it.
 * - `releaseAt`: when its vDisk leadership (in Zeus) is free for a peer Stargate. An orderly stop
 *   or a process exit releases it at once; a silent Stargate or a rebooting CVM keeps it until its
 *   Zookeeper session expires (`hci.stargateDownDetectS`). With `strict`, peers see the release
 *   only after that tick (a ZK session lost and connections reset at the same moment).
 */
export interface StargateOutage {
  readonly since: number;
  readonly resetAt: number | null;
  readonly releaseAt: number;
  readonly strict: boolean;
}

/** How a Stargate stopped serving (see `StargateOutage`). */
type DownHow = 'orderly' | 'exit' | 'reboot' | 'silent' | 'hang' | 'zk-lost';

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
  private stargateCmd: 'stop' | 'start' | 'crash' | 'hang' | 'resume' | null = null;
  private hadesWake: TimerHandle | null = null;
  private stopCause: 'clean-stop' | 'silent' = 'silent';
  /** `cvm.network-flap`: requested blackout length, and when the current one ends. */
  private flapRequest: number | null = null;
  private flapUntil: number | null = null;
  private flapSince: number | null = null;
  /** The current Stargate outage (null while it serves). */
  private outageRec: StargateOutage | null = null;
  /** Stargate dropped out because its ZK session expired during a blackout. */
  private zkDropped = false;
  /** `cvm.network-loss`: requested loss on its cluster network (percent; 0 clears it). */
  private lossRequest: number | null = null;
  /** Stargate dropped out because its ZK session expired over a lossy cluster network. */
  private lossDropped = false;
  /** Stargate failed fast on operations hung on a partly unresponsive peer; held down until then. */
  private hungOpHeld = false;
  private restartTimer: TimerHandle | null = null;
  /** `cvm.internal-link-down` / `-up`: requested state, and whether the link is down now. */
  private internalLinkRequest: boolean | null = null;
  private internalLinkDown = false;
  /**
   * Planned shutdown (`cvm.planned-shutdown`, the upgrade / LCM path): `preparing` while the
   * cluster forwards traffic away and stops services, `off` once powered off; it stays off (no
   * automatic boot) until `cvm.planned-start`.
   */
  private planned: 'none' | 'requested' | 'preparing' | 'off' = 'none';
  private plannedStartRequested = false;
  private plannedTimer: TimerHandle | null = null;

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
    return this.running() && this.stargate.serving;
  }

  /**
   * Why Stargate is not serving: `clean-stop` when it was stopped in an orderly way
   * (`cvm.stop-stargate`, Hades maintenance, a process exit on a live CVM), `silent` when peers
   * learn of it only from its Zookeeper session expiring (power loss, hang, CVM reboot); null
   * while it serves.
   */
  stargateDownCause(): 'clean-stop' | 'silent' | null {
    if (this.stargateServing()) return null;
    return this.stargate.hung ? 'silent' : this.stopCause;
  }

  /**
   * Cut off by a network blackout for less than the ZK session timeout: it still holds its
   * Zookeeper session, so its Stargate keeps serving the vDisks it hosts.
   */
  zkSessionHeld(now: number): boolean {
    const D = this.reg.profile.hci.stargateDownDetectS.value;
    return this.flapUntil !== null && this.flapSince !== null && now - this.flapSince < D;
  }

  /** The current Stargate outage as initiators and peers see it (null while it serves). */
  outage(): StargateOutage | null {
    if (this.stargateServing()) return null;
    return this.outageRec ?? { since: 0, resetAt: 0, releaseAt: 0, strict: false };
  }

  /**
   * Record how Stargate stopped serving. Called just before (or as) it stops; an outage already
   * in progress keeps its start and takes the earlier release and any new connection reset.
   */
  private noteDown(how: DownHow, now: number): void {
    const D = this.reg.profile.hci.stargateDownDetectS.value;
    const reset = how === 'silent' || how === 'hang' ? null : now;
    const releaseAt = how === 'orderly' || how === 'exit' || how === 'zk-lost' ? now : now + D;
    const prev = this.stargateServing() ? null : this.outageRec;
    if (prev === null) {
      this.outageRec = { since: now, resetAt: reset, releaseAt, strict: how === 'zk-lost' };
      return;
    }
    this.outageRec = {
      since: prev.since,
      resetAt: reset ?? prev.resetAt,
      releaseAt: Math.min(prev.releaseAt, releaseAt),
      strict: prev.strict && releaseAt >= prev.releaseAt,
    };
  }

  relinquish(vdisk: string): void {
    this.stargate.relinquish(vdisk);
  }

  requestReboot(): void {
    this.rebootRequested = true;
  }

  /**
   * `stop` / `start`: orderly. `crash`: the process exits; its self-monitor restarts it after
   * `cluster.stargateSelfRestartS`. `hang`: the process stays alive but stops answering (no IO,
   * no NOPs, connections stay open). `resume`: a hung process runs again; its watchdog fires, so it
   * exits and is restarted like a crash.
   */
  requestStargate(cmd: 'stop' | 'start' | 'crash' | 'hang' | 'resume'): void {
    this.stargateCmd = cmd;
  }

  /** `cvm.planned-shutdown`: the caller already granted this CVM the cluster's shutdown token. */
  requestPlannedShutdown(): void {
    if (this.planned === 'none') this.planned = 'requested';
  }

  /** `cvm.planned-start`: power a CVM that was shut down in a planned way back on. */
  requestPlannedStart(): void {
    if (this.planned === 'off') this.plannedStartRequested = true;
  }

  plannedState(): 'none' | 'preparing' | 'off' {
    return this.planned === 'requested' ? 'preparing' : this.planned;
  }

  /** `cvm.network-flap`: the CVM's inter-CVM interface goes dark for `seconds`, then returns. */
  requestNetworkFlap(seconds: number): void {
    this.flapRequest = seconds;
  }

  /** `cvm.network-loss`: packet loss on the CVM's cluster network (percent; 0 clears it). */
  requestNetworkLoss(pct: number): void {
    this.lossRequest = pct;
  }

  /**
   * `cvm.internal-link-down` / `-up`: the host-internal link between the AHV host and this CVM
   * fails or returns. Its cluster network and storage paths stay up.
   */
  requestInternalLink(up: boolean): void {
    this.internalLinkRequest = up;
  }

  internalLinkUp(): boolean {
    return !this.internalLinkDown;
  }

  /**
   * The host's initiators reach this CVM's Stargate over the host-internal link. With it down they
   * miss their NOPs and log in again through the redirector; a peer then sends each session on to
   * this CVM's external portal while it is alive, so the same Stargate keeps serving (SPEC §6.2).
   */
  private stepInternalLink(ctx: Ctx): void {
    const up = this.internalLinkRequest;
    this.internalLinkRequest = null;
    if (up === null || up === !this.internalLinkDown) return;
    this.internalLinkDown = !up;
    const ectx = asEngineContext(ctx);
    const ep = this.facts.internalEndpoint;
    if (this.power !== 'off')
      ectx.endpoints.setUp(ep, up, up ? [] : (this.reg.causes.get(this.id) ?? []));
    const R = ctx.profile.redirector;
    ctx.emit({
      severity: up ? 'info' : 'warn',
      deviceId: this.id,
      code: up ? 'cvm.internal-link.up' : 'cvm.internal-link.down',
      text: up
        ? `${this.label}: the host-internal link to its AHV host is back; sessions already moved to its external portal stay there for the validity window`
        : `${this.label}: the host-internal link to its AHV host is down; its cluster network and storage paths stay up. The host's initiators miss their NOPs and log in again through the redirector`,
      causeIds: up ? [] : (this.reg.causes.get(this.id) ?? []),
      cite: R.externalPathValidityS.cite,
      confidence: 'assumption',
    });
  }

  /**
   * Partial unresponsiveness (SPEC §6.2 "Degraded Node Detection"). Loss below
   * `dnd.partialLossPct` only makes peers score the CVM as an outlier. Heavier loss leaves it
   * half reachable: its own Stargate drops out once its Zookeeper session expires (as in a
   * blackout), but it keeps its metadata role, so its peers' Stargate operations hang until it is
   * marked Degraded or the loss ends (see `stepHungOps`).
   */
  private stepLoss(ctx: Ctx): void {
    const reg = this.reg;
    const causeIds = reg.causes.get(this.id) ?? [];
    const T = ctx.profile.dnd.partialLossPct;
    const D = ctx.profile.hci.stargateDownDetectS;
    if (this.lossRequest !== null) {
      const pct = this.lossRequest;
      this.lossRequest = null;
      const prev = reg.netLoss.get(this.id);
      if (pct <= 0) {
        if (prev) {
          reg.netLoss.delete(this.id);
          ctx.emit({
            severity: 'info',
            deviceId: this.id,
            code: 'cvm.network.loss-cleared',
            text: `${this.label}: its cluster network is clean again`,
            causeIds,
            cite: T.cite,
            confidence: 'assumption',
          });
        }
        if (this.lossDropped) {
          this.lossDropped = false;
          this.scheduleRestart(
            ctx,
            `${this.label}: back in touch with its peers; Stargate restarted`,
          );
        }
      } else {
        reg.netLoss.set(this.id, { pct, since: prev?.since ?? ctx.now });
        const partial = pct >= T.value;
        ctx.emit({
          severity: partial ? 'warn' : 'info',
          deviceId: this.id,
          code: partial ? 'cvm.network.lossy' : 'dnd.outlier',
          text: partial
            ? `${this.label}: ${pct} % packet loss on its cluster network. It is half reachable: peers' calls to it time out, yet it keeps its metadata role, and Degraded Node Detection starts scoring it`
            : `${this.label}: ${pct} % packet loss on its cluster network. Peers score it as an outlier; IO is not affected`,
          causeIds,
          cite: T.cite,
          confidence: 'assumption',
        });
        if (partial) {
          const H = ctx.profile.cluster.stargateHungOpS;
          ctx.timers.set(
            `${this.id} lossy zk`,
            D.value,
            { cite: D.cite, confidence: D.confidence },
            () => {},
          );
          ctx.timers.set(
            `${this.id} lossy hung ops`,
            H.value,
            { cite: H.cite, confidence: H.confidence },
            () => {},
          );
        }
      }
    }
    const l = reg.netLoss.get(this.id);
    if (
      l &&
      reg.partlyUnresponsive(this.id) &&
      ctx.now - l.since >= D.value &&
      this.stargateServing()
    ) {
      this.noteDown('zk-lost', ctx.now);
      this.stargate.setProcess(false);
      this.lossDropped = true;
      ctx.emit({
        severity: 'warn',
        deviceId: this.id,
        code: 'stargate.zk-session-lost',
        text: `${this.label}: over its lossy cluster network its Stargate lost its Zookeeper session and dropped out; its sessions are reset and move to other Stargates. Prism alert A1030 "Stargate Temporarily Down"`,
        causeIds,
        cite: [...D.cite, 'ntnx-pe-alerts-7.0-cluster'],
        confidence: 'assumption',
      });
    }
  }

  /**
   * A peer is partly unresponsive and still holds its metadata role: this Stargate's operations
   * that touch it hang, and after `cluster.stargateHungOpS` it fails fast (its connections are
   * reset, its vDisks are free). Its self-monitor restarts it, but its operations hang again, so
   * it is held down until the peer is marked Degraded or its network is clean again.
   */
  private stepHungOps(ctx: Ctx): void {
    const hang = this.reg.metadataHang(this.id);
    const H = ctx.profile.cluster.stargateHungOpS;
    if (hang !== null && ctx.now - hang.since >= H.value && this.stargateServing()) {
      const peer = this.reg.cvms.get(hang.cvm)?.label ?? hang.cvm;
      this.hungOpHeld = true;
      this.stopCause = 'clean-stop';
      this.noteDown('exit', ctx.now);
      this.stargate.setHung(false);
      this.backend.onFail?.(ctx);
      this.stargate.setProcess(false);
      ctx.emit({
        severity: 'error',
        deviceId: this.id,
        code: 'stargate.hung-op-fail-fast',
        text: `${this.label}: Stargate operations on ${peer}'s metadata hung for ${H.value} s, so Stargate failed fast; its connections are reset and its vDisks are free. Its self-monitor restarts it, but its operations hang again until ${peer} is marked Degraded or reachable again. Prism alert A1030 "Stargate Temporarily Down"`,
        causeIds: this.reg.causes.get(hang.cvm) ?? [],
        cite: [...H.cite, 'ntnx-pe-alerts-7.0-cvm'],
        confidence: H.confidence,
      });
    } else if (this.hungOpHeld && hang === null) {
      this.hungOpHeld = false;
      if (this.running() && !this.stargate.processUp) {
        this.scheduleRestart(
          ctx,
          `${this.label}: its peer's metadata no longer blocks it; Stargate restarted by its self-monitor`,
        );
      }
    }
  }

  /** Start or end a peer-communication blackout (the CVM keeps running). */
  private stepFlap(ctx: Ctx): void {
    const ectx = asEngineContext(ctx);
    const ep = this.facts.dataEndpoint;
    if (this.flapRequest !== null && this.power !== 'off') {
      this.flapUntil = ctx.now + this.flapRequest;
      this.flapSince ??= ctx.now;
      this.flapRequest = null;
      ectx.endpoints.setUp(ep, false, this.reg.causes.get(this.id) ?? []);
      ctx.emit({
        severity: 'warn',
        deviceId: this.id,
        code: 'cvm.network.blackout',
        text: `${this.label}: its inter-CVM interface stops answering for ${this.flapUntil - ctx.now} s (network flap); the CVM keeps running`,
        causeIds: this.reg.causes.get(this.id) ?? [],
        cite: ['ntnx-community-dnd'],
        confidence: 'assumption',
      });
    }
    // A blackout as long as the ZK session timeout: the Stargate loses its Zookeeper session and
    // drops out (its process exits and keeps restarting while it cannot reach Zeus). Its local
    // sessions are reset at that moment; until then it kept serving them (SPEC §6.2).
    const D = ctx.profile.hci.stargateDownDetectS;
    if (
      this.flapUntil !== null &&
      this.flapSince !== null &&
      ctx.now - this.flapSince >= D.value &&
      this.stargateServing()
    ) {
      this.noteDown('zk-lost', ctx.now);
      this.stargate.setProcess(false);
      this.zkDropped = true;
      ctx.emit({
        severity: 'warn',
        deviceId: this.id,
        code: 'stargate.zk-session-lost',
        text: `${this.label}: cut off from its peers for ${ctx.now - this.flapSince} s, its Stargate lost its Zookeeper session and dropped out; its sessions are reset and move to other Stargates. Prism alert A1030 "Stargate Temporarily Down"`,
        causeIds: this.reg.causes.get(this.id) ?? [],
        cite: [...D.cite, 'ntnx-pe-alerts-7.0-cluster'],
        confidence: 'assumption',
      });
    }
    if (this.flapUntil !== null && ctx.now >= this.flapUntil) {
      this.flapUntil = null;
      this.flapSince = null;
      if (this.power !== 'off') ectx.endpoints.setUp(ep, true);
      if (this.zkDropped) {
        this.zkDropped = false;
        this.scheduleRestart(
          ctx,
          `${this.label}: back in touch with its peers; Stargate restarted`,
        );
      }
    }
  }

  /** The self-monitor restarts an exited Stargate process (`cluster.stargateSelfRestartS`). */
  private scheduleRestart(ctx: Ctx, text: string): void {
    const R = ctx.profile.cluster.stargateSelfRestartS;
    if (this.restartTimer) ctx.timers.cancel(this.restartTimer);
    this.restartTimer = ctx.timers.set(
      `${this.id} stargate restart`,
      R.value,
      { cite: R.cite, confidence: R.confidence },
      () => {
        this.restartTimer = null;
        if (
          !this.running() ||
          this.stargate.processUp ||
          this.zkDropped ||
          this.lossDropped ||
          this.hungOpHeld
        ) {
          return;
        }
        this.stargate.setProcess(true);
        this.backend.onRecover?.(ctx);
        this.emitStargateUp(ctx, text);
      },
    );
  }

  // ── Hooks ───────────────────────────────────────────────────────────────

  preTick(ctx: Ctx): void {
    const hostUp = this.reg.hostAlive(this.hostId);
    if (!hostUp && this.power !== 'off') {
      this.stopCause = 'silent';
      this.noteDown('silent', ctx.now);
      this.goDown(ctx, true);
    } else if (hostUp && this.engineUp && this.power === 'off' && this.planned !== 'off') {
      this.boot(ctx);
    }
    if (this.planned === 'requested') this.beginPlannedShutdown(ctx);
    if (this.plannedStartRequested) {
      this.plannedStartRequested = false;
      if (this.planned === 'off') {
        this.planned = 'none';
        if (hostUp && this.engineUp) this.boot(ctx);
      }
    }
    if (this.rebootRequested) {
      this.rebootRequested = false;
      if (this.power !== 'off') {
        // The OS stops its processes, so connections are reset at once, but Stargate's vDisk
        // leadership is released only when its Zookeeper session expires (SPEC §6.2).
        this.stopCause = 'silent';
        this.noteDown('reboot', ctx.now);
        this.goDown(ctx, false);
        this.boot(ctx);
      }
    }
    if (this.stargateCmd !== null) this.applyStargateCmd(ctx);
    if (this.internalLinkRequest !== null) this.stepInternalLink(ctx);
    if (this.flapRequest !== null || this.flapUntil !== null) this.stepFlap(ctx);
    if (this.lossRequest !== null || this.reg.netLoss.has(this.id)) this.stepLoss(ctx);
    if (this.power === 'running' && (this.hungOpHeld || this.reg.netLoss.size > 0)) {
      this.stepHungOps(ctx);
    }
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
    this.cancelPlanned(ctx);
    this.stopCause = 'silent';
    this.noteDown('silent', ctx.now);
    this.stargate.setHung(false);
    this.zkDropped = false;
    this.lossDropped = false;
    this.hungOpHeld = false;
    if (this.restartTimer) ctx.timers.cancel(this.restartTimer);
    this.restartTimer = null;
    if (this.running()) this.failComponents(ctx);
    else if (this.power === 'running') this.backend.onFail?.(ctx);
    this.power = 'off';
    this.bootTimer = null;
    this.hadesWake = null;
    this.hades.reset();
  }

  onRecover(ctx: Ctx): void {
    this.engineUp = true;
    // A generic power-on also ends a planned shutdown.
    this.planned = 'none';
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
      ? this.running() && this.stargate.hung
        ? 'hung'
        : 'down'
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
      // Degraded Node Detection (SPEC §6.2): ok | scoring | degraded.
      dndState: this.reg.dnd.get(this.id) ?? 'ok',
      ownedVdisks: this.stargate.ownedVdisks(),
      backend: this.backend.kind,
      backendHealth: this.backend.health(),
      // T1: Hades maintenance mode after losing the service volumes (`ok` elsewhere).
      hades: this.hades.state,
      // Host-internal link between the AHV host and this CVM (up | down).
      internalLink: this.internalLinkDown ? 'down' : 'up',
      // Planned shutdown (`cvm.planned-shutdown`): none | preparing | off.
      plannedShutdown: this.plannedState(),
    };
    for (const c of this.components) Object.assign(fields, c.viewFields?.() ?? {});
    const badges: string[] = [];
    if (this.reg.zkLeader === this.id) badges.push('zk-leader');
    if (this.reg.zkMembers.has(this.id)) badges.push('zk');
    if (this.reg.isDegraded(this.id)) badges.push('degraded');
    let status: DeviceStatus = 'healthy';
    if (!up) status = 'offline';
    else if (this.power === 'booting' || stargate !== 'up' || this.reg.isDegraded(this.id)) {
      status = 'degraded';
    }
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
   * Hades maintenance only the backend runs (it keeps reconnecting, the volume check's proxy).
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
    this.stargate.setHung(false);
    this.stargate.setProcess(false);
    this.zkDropped = false;
    this.lossDropped = false;
    this.hungOpHeld = false;
    if (this.restartTimer) ctx.timers.cancel(this.restartTimer);
    this.restartTimer = null;
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
        if (this.reg.plannedShutdownToken === this.id) this.reg.plannedShutdownToken = null;
        for (const c of this.components) c.onRecover?.(ctx);
        this.emitStargateUp(ctx, `${this.label} booted; Stargate is serving`);
      },
    );
  }

  // ── Planned shutdown (upgrade / LCM path) ──────────────────────────────

  /**
   * Planned shutdown, the documented node-shutdown path (AHV Admin Guide "Shutting Down a Node"): with the
   * shutdown token granted, traffic is forwarded away and services stop in an orderly way, then the
   * CVM powers off (`cluster.plannedShutdownPrepS`). An orderly Stargate stop resets its connections
   * and releases its vDisk leadership at once, so the VMs' sessions log in to peers and IO resumes
   * after the re-login, with no silent-CVM pause. The CVM stays off until `cvm.planned-start`.
   */
  private beginPlannedShutdown(ctx: Ctx): void {
    if (this.power !== 'running') {
      this.planned = 'none';
      if (this.reg.plannedShutdownToken === this.id) this.reg.plannedShutdownToken = null;
      return;
    }
    const W = ctx.profile.cluster.plannedShutdownPrepS;
    this.planned = 'preparing';
    const cite: KnownCitationId[] = ['ntnx-ahv-admin-11.2'];
    ctx.emit({
      severity: 'info',
      deviceId: this.id,
      code: 'cvm.planned-shutdown.start',
      text: `${this.label}: planned shutdown: the cluster grants the shutdown token (one CVM at a time), forwards its traffic away and stops its services in an orderly way; it powers off in about ${W.value} s`,
      causeIds: this.reg.causes.get(this.id) ?? [],
      cite,
      confidence: W.confidence,
    });
    if (this.plannedTimer) ctx.timers.cancel(this.plannedTimer);
    this.plannedTimer = ctx.timers.set(
      `${this.id} planned shutdown`,
      W.value,
      { cite: W.cite, confidence: W.confidence },
      () => {
        this.plannedTimer = null;
        if (this.planned !== 'preparing' || this.power === 'off') return;
        this.stopCause = 'clean-stop';
        if (this.stargateServing()) this.noteDown('orderly', ctx.now);
        this.goDown(ctx, true);
        this.planned = 'off';
        ctx.emit({
          severity: 'warn',
          deviceId: this.id,
          code: 'cvm.planned-shutdown.off',
          text: `${this.label} is powered off after an orderly shutdown: its Stargate released its vDisks first, so its VMs' IO moved to other Stargates without waiting for a Zookeeper expiry`,
          causeIds: this.reg.causes.get(this.id) ?? [],
          cite,
          confidence: W.confidence,
        });
      },
    );
  }

  private cancelPlanned(ctx: Ctx): void {
    if (this.plannedTimer) ctx.timers.cancel(this.plannedTimer);
    this.plannedTimer = null;
    if (this.planned === 'requested' || this.planned === 'preparing') this.planned = 'none';
    if (this.planned === 'none' && this.reg.plannedShutdownToken === this.id) {
      this.reg.plannedShutdownToken = null;
    }
  }

  // ── Hades (T1) ──────────────────────────────────────────────────────────

  private stepHades(ctx: Ctx): void {
    const step = this.hades.step(ctx, this.hades.state !== 'ok' || this.stargate.processUp);
    if (step === 'enter-maintenance') this.enterMaintenance(ctx);
    else if (step === 'volumes-healthy') this.exitMaintenance(ctx);
    this.wakeHades(ctx);
  }

  /** Hades: service volumes lost past the threshold → maintenance mode, services stop. */
  private enterMaintenance(ctx: Ctx): void {
    const H = ctx.profile.hades;
    // Each node decides on its own service volumes: there is no cluster-wide admission limit, so
    // a whole-array loss puts every node in maintenance and no Stargate is left to serve
    // (`assumption`, SPEC §6.4 "T1 full array loss").
    this.stopCause = 'clean-stop';
    this.noteDown('orderly', ctx.now);
    this.failComponents(ctx);
    this.stargate.setProcess(false);
    // The CVM's NVMe initiator keeps trying to reach the array (its controllers reconnect).
    this.backend.onRecover?.(ctx);
    this.hades.enterMaintenance(ctx.now);
    const cite: KnownCitationId[] = [
      'ntnx-cmdref-aos-7.6',
      'ntnx-bible-8c',
      'ntnx-pe-alerts-7.0-cluster',
    ];
    ctx.emit({
      severity: 'error',
      deviceId: this.id,
      code: 'hades.maintenance.enter',
      text: `${this.label}: service volumes unreachable (every NVMe path lost) for ${H.externalStorageErrorThresholdS.value} s; Hades puts the node in maintenance mode and its services (Stargate, Zookeeper, Cassandra) stop. Prism alerts A3032 "Cluster services are down" and A1030 "Stargate Temporarily Down"`,
      causeIds: this.reg.causes.get(this.id) ?? [],
      cite,
      confidence: H.maintenanceOnStorageError.confidence,
    });
  }

  /**
   * A volume check found the service-volume mounts healthy again: Hades takes the node out of
   * maintenance and the services restart (`hades.servicesRestartS`). The redirector fails back
   * only after its stable window.
   */
  private exitMaintenance(ctx: Ctx): void {
    const R = ctx.profile.hades.servicesRestartS;
    const H = ctx.profile.hades.volumeMonitorIntervalS;
    this.hades.beginRestart();
    ctx.emit({
      severity: 'info',
      deviceId: this.id,
      code: 'hades.maintenance.exit',
      text: `${this.label}: the service-volume mounts are healthy again at Hades' ${H.value} s volume check; the node leaves maintenance mode and its services restart (about ${R.value} s)`,
      causeIds: [],
      cite: [...new Set([...H.cite, ...R.cite])],
      confidence: R.confidence,
    });
    if (this.bootTimer) ctx.timers.cancel(this.bootTimer);
    this.bootTimer = ctx.timers.set(
      `${this.id} services restart`,
      R.value,
      { cite: R.cite, confidence: R.confidence },
      () => {
        this.bootTimer = null;
        this.hades.reset();
        this.runningSince = ctx.now;
        this.stargate.setProcess(true);
        // The backend kept running through maintenance: it is not restarted.
        for (const c of this.components) if (c !== this.backend) c.onRecover?.(ctx);
        this.emitStargateUp(
          ctx,
          `${this.label}: services restarted after maintenance mode; Stargate is serving`,
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
    const H = ctx.profile.hades.volumeMonitorIntervalS;
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
    const causeIds = this.reg.causes.get(this.id) ?? [];
    if (cmd === 'stop' && this.stargate.processUp) {
      this.stopCause = 'clean-stop';
      this.noteDown('orderly', ctx.now);
      this.stargate.setHung(false);
      this.backend.onFail?.(ctx);
      this.stargate.setProcess(false);
      ctx.emit({
        severity: 'warn',
        deviceId: this.id,
        code: 'stargate.down',
        text: `${this.label}: Stargate stopped. Prism alert A1030 "Stargate Temporarily Down"`,
        causeIds,
        cite: ['ntnx-pe-alerts-7.0-cvm'],
      });
    } else if (cmd === 'start' && !this.stargate.processUp) {
      // Stargate start time is not modeled (`assumption`: immediate).
      this.stargate.setProcess(true);
      this.backend.onRecover?.(ctx);
      this.emitStargateUp(ctx, `${this.label}: Stargate started`);
    } else if (cmd === 'crash' && this.stargate.processUp) {
      this.exitProcess(ctx, causeIds, 'crashed');
    } else if (cmd === 'hang' && this.stargateServing()) {
      this.stopCause = 'silent';
      this.noteDown('hang', ctx.now);
      this.stargate.setHung(true);
      const D = ctx.profile.hci.stargateDownDetectS;
      ctx.emit({
        severity: 'warn',
        deviceId: this.id,
        code: 'stargate.hung',
        text: `${this.label}: Stargate hangs: its process is alive but answers neither IO nor NOPs, and its connections stay open. Initiators notice only when their NOPs go unanswered; peers may take its vDisks only once its Zookeeper session expires (about ${D.value} s)`,
        causeIds,
        cite: [...D.cite, ...ctx.profile.redirector.nopIntervalS.cite],
        confidence: 'assumption',
      });
    } else if (cmd === 'resume' && this.stargate.hung) {
      // Its watchdog fires as soon as it runs again: the process exits and is restarted.
      this.exitProcess(ctx, causeIds, 'resumed; its watchdog fired, so it exited');
    }
  }

  /** The Stargate process exits on a live CVM (crash, watchdog): its self-monitor restarts it. */
  private exitProcess(ctx: Ctx, causeIds: readonly string[], why: string): void {
    const R = ctx.profile.cluster.stargateSelfRestartS;
    this.stopCause = 'clean-stop';
    this.noteDown('exit', ctx.now);
    this.stargate.setHung(false);
    this.backend.onFail?.(ctx);
    this.stargate.setProcess(false);
    ctx.emit({
      severity: 'warn',
      deviceId: this.id,
      code: 'stargate.crashed',
      text: `${this.label}: the Stargate process ${why}. The CVM resets its connections, so initiators log in elsewhere at once and its vDisks are free for peers; its self-monitor restarts it in about ${R.value} s. Prism alert A1030 "Stargate Temporarily Down"`,
      causeIds,
      cite: [...R.cite, 'ntnx-pe-alerts-7.0-cvm'],
      confidence: R.confidence,
    });
    this.scheduleRestart(ctx, `${this.label}: Stargate restarted by its self-monitor`);
  }

  private emitStargateUp(ctx: Ctx, text: string): void {
    this.outageRec = null;
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
      // A failed host-internal link stays down across a CVM boot.
      const want = up && !(this.internalLinkDown && e.id === this.facts.internalEndpoint);
      if (ectx.net.isAdminUp(e.id) !== want) ectx.endpoints.setUp(e.id, want);
    }
  }
}
