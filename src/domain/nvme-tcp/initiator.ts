/**
 * NVMe/TCP host initiator inside one CVM (Stargate's SPDK initiator; Nutanix Bible "External
 * Storage Architecture"). A `StorageBackend` of kind `external-nvme` and a `CvmComponent` the CVM
 * delegates its hooks to. Behavior follows SPEC §6.4c exactly; every timer is a profile field
 * (`profile.externalStorage.*`), the multipath policy and path selector are the `multipath-policy`
 * and `nvme-path-selector` topology options.
 *
 * Paths. One NVMe controller per (CVM storage endpoint × target interface on the same VLAN). Each
 * is 1 admin-queue + `ioQueuesPerPath` IO-queue TCP connections with distinct source ports, so
 * balance-tcp hashes them independently and balance-slb pins them by the vNIC's MAC (§6.4b). On a
 * physical FlashArray every path is ANA Optimized (Everpure ANA FAQ), so all live paths are equal.
 *
 * Timing (NVMe Base Spec 2.1 §3.9.3.1.2 Keep Alive, §9.6 communication loss; values in the profile):
 * 1. Keep Alive is sent on the admin queue every KATO/2. Only admin-queue exchanges count.
 * 2. A path is lost KATO after its last successful exchange (silent loss: the CVM vNIC never sees
 *    uplink carrier loss; the spec allows up to 1.5 × KATO, the model uses KATO), or at once if the
 *    far end is reachable and refuses (fast loss, e.g. an interface disabled or a controller
 *    rebooting gracefully: the frame reaches the target device but its endpoint is down; `inferred`).
 * 3. Until then the initiator cannot tell the path is dead, so the selector keeps giving it new IO
 *    (see "Path selection"). Once lost, new IO uses the live paths. Commands in flight on a silently
 *    lost path are retried on another path at `lostPathHoldKatoMultiplier × KATO + CQT` after its
 *    last successful exchange (§9.6.2–9.6.3: give the controller time to detect the loss, then CQT
 *    to quiesce); on a connection the target closed, CQT after the loss (§9.6.2 step 2c). Reads
 *    could retry at detection; the model holds all IO (conservative). A command stuck on a live but
 *    broken queue (hung bond member, no carrier loss) is aborted after `ioTimeoutS` and retried
 *    (SPEC §14 #4).
 * 4. A lost path reconnects every `reconnectDelayS`; after `controllerLossTimeoutS` its controller
 *    is deleted (`RECONNECT_FOREVER` = never).
 * 5. With no live path IO stays queued and is retried until the array responds (DEPLOY-GUIDE);
 *    it fails to the guest only once every path's controller is deleted.
 *
 * Path selection (`active-active`, SPEC §6.4b; SPDK bdev_nvme selectors):
 * - `queue-depth`: the live path with the fewest outstanding commands (ties in turn). A silently
 *   dead path keeps its stuck commands, so it soon stops getting new IO: a partial stall (the
 *   guest's effective queue depth drops and the stuck commands are latency outliers).
 * - `round-robin`: the next live path in turn. A queue-depth-bound guest re-issues each completed IO
 *   at once, and with sub-millisecond service times every one of its slots lands on the dead path
 *   within a fraction of a second. The model's few IOs per tick stand for that closed loop
 *   (`assumption`): once a vDisk has a command stuck on a path still believed live, its new IO goes
 *   to that path too, and once the path is declared lost, its new IO waits until the held commands
 *   are retried (the guest has no free slot to issue it from). A full stall, until the hold expires.
 *
 * TCP is abstracted: a frame the network dropped silently is retransmitted on the next tick
 * (an `assumption`: real RTO backoff is sub-second at first, then grows).
 */
import { asEngineContext, type EngineTickContext, type EngineTrace } from '../../engine/context';
import type {
  DeviceId,
  EndpointId,
  Message,
  MessageDraft,
  SimTime,
  TimerHandle,
  ViewField,
} from '../../engine/types';
import type { KnownCitationId } from '../citations';
import type { ClusterView, Ctx, IoCompletion, IoRequest, StorageBackend } from '../contracts';
import { RECONNECT_FOREVER } from '../versions/cited';
import type { MultipathPolicy, PathSelector, Profile } from '../versions/profile';
import { CauseIndex } from './causes';
import {
  type AdminPayload,
  type CommandPayload,
  type CommandRespPayload,
  type ConnectRespPayload,
  NVME_MSG,
  NVME_TCP_PORT,
  pathIdOf,
} from './protocol';

export type PathState = 'live' | 'lost' | 'removed';

export interface NvmePathConfig {
  /** CVM storage endpoint (one vNIC on one storage VLAN). */
  readonly local: EndpointId;
  /** Target interface (an FA nvme-tcp data IP). */
  readonly remote: EndpointId;
}

export interface NvmeTcpInitiatorOptions {
  readonly cvm: DeviceId;
  readonly profile: Profile;
  readonly policy: MultipathPolicy;
  /** `active-active` path selector; defaults to the profile's `pathSelector`. */
  readonly selector?: PathSelector;
  readonly paths: readonly NvmePathConfig[];
  /**
   * Rebuild paths from the cluster's storage endpoints at `attach` (used when the topology's view
   * is not known up front). Defaults to keeping `paths`.
   */
  readonly pathsFor?: (storageEndpoints: readonly EndpointId[]) => readonly NvmePathConfig[];
  readonly causes?: CauseIndex;
}

/** A frame on the wire whose fate (trace) is not yet known. */
interface Wire {
  readonly msgId: string;
  readonly sentAt: SimTime;
  readonly draft: MessageDraft;
  resend: boolean;
}

interface Path {
  readonly id: string;
  readonly local: EndpointId;
  readonly remote: EndpointId;
  state: PathState;
  /** Association generation: bumped on every (re)connect; stale replies are ignored. */
  gen: number;
  adminPort: number;
  ioPorts: number[];
  nextQueue: number;
  lastOkAt: SimTime;
  /** Fractional schedule: Keep Alive every KATO/2. */
  nextKaAt: number;
  ka: Wire | null;
  connect: Wire | null;
  lostAt: SimTime | null;
  nextReconnectAt: SimTime | null;
  /** Where its last dropped frame died (for causal chains). */
  lastDropAt: string | undefined;
}

type CmdBody =
  | { readonly type: 'io'; readonly req: IoRequest }
  | { readonly type: 'resv'; readonly vdisk: string; readonly action: 'acquire' | 'release' };

interface Cmd {
  readonly id: string;
  readonly body: CmdBody;
  attempt: number;
  state: 'queued' | 'inflight' | 'held';
  path: string | null;
  /** Start of the current attempt on its path (for the IO timeout). */
  startedAt: SimTime;
  holdUntil: SimTime;
  wire: Wire | null;
  /** Path to avoid on the next dispatch (the one that failed it). */
  avoid: string | null;
  /** Held, retried or retransmitted: latency is then the real wait, not the wire time. */
  delayed: boolean;
  /** Its frame was dropped on a path the initiator still believes live (a silent dead path). */
  stuck: boolean;
}

interface UsageWire {
  readonly vdisk: string;
  readonly path: string;
  readonly msgId: string;
  readonly sentAt: SimTime;
}

interface Usage {
  readonly paths: Map<string, Set<string>>;
  readonly uplinks: Map<string, Set<string>>;
}

const emptyUsage = (): Usage => ({ paths: new Map(), uplinks: new Map() });

function addTo(m: Map<string, Set<string>>, k: string, v: string): void {
  let s = m.get(k);
  if (!s) {
    s = new Set();
    m.set(k, s);
  }
  s.add(v);
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const EPHEMERAL_BASE = 33000;
const EPHEMERAL_SPAN = 28000;

export class NvmeTcpInitiator implements StorageBackend {
  readonly kind = 'external-nvme' as const;
  readonly name = 'nvme-tcp-initiator';
  readonly cvm: DeviceId;
  readonly policy: MultipathPolicy;
  readonly selector: PathSelector;

  private readonly es: Profile['externalStorage'];
  private readonly causes: CauseIndex;
  private readonly rebuild: NvmeTcpInitiatorOptions['pathsFor'];
  private paths: Path[] = [];
  /**
   * Paths interleaved across the CVM's storage vNICs (A0, B0, A1, B1, …), the order active-active
   * takes them in. A vDisk's IO spreads over every path over time; with the model's few IOs per
   * tick, interleaving keeps each tick's sample on both storage VLANs (a sampling choice, not
   * vendor behavior).
   */
  private order: Path[] = [];
  private readonly cmds = new Map<string, Cmd>();
  private completions: IoCompletion[] = [];
  private readonly rr = new Map<string, number>();
  private readonly active = new Map<string, string>();
  /** Round-robin: vDisk → time its new IO may go out again (its guest slots are all held). */
  private readonly blocked = new Map<string, SimTime>();
  private readonly reservations = new Set<string>();
  private readonly conflictAnnounced = new Set<string>();
  private usageWires: UsageWire[] = [];
  private usage: Usage = emptyUsage();
  private lastUsage: Usage = emptyUsage();
  private allLostAnnounced = false;
  private allRemovedAnnounced = false;
  private portSeq = 0;
  private timer: TimerHandle | null = null;

  constructor(opts: NvmeTcpInitiatorOptions) {
    this.cvm = opts.cvm;
    this.policy = opts.policy;
    this.es = opts.profile.externalStorage;
    this.selector = opts.selector ?? this.es.pathSelector.value;
    this.causes = opts.causes ?? new CauseIndex();
    this.rebuild = opts.pathsFor;
    this.setPaths(opts.paths);
  }

  // ── Profile timers (SPEC §6.4c) ───────────────────────────────────────────

  private get kato(): number {
    return this.es.keepAliveTimeoutS.value;
  }
  private get cqt(): number {
    return this.es.commandQuiesceTimeS.value;
  }
  /** Retry time of commands in flight on a silently lost path, from its last exchange. */
  private get silentHoldS(): number {
    return this.es.lostPathHoldKatoMultiplier.value * this.kato + this.cqt;
  }
  private get reconnectDelay(): number {
    return Math.max(1, this.es.reconnectDelayS.value);
  }
  private get ctrlLoss(): number {
    return this.es.controllerLossTimeoutS.value;
  }
  private get ioTimeout(): number {
    return this.es.ioTimeoutS.value;
  }
  private get queues(): number {
    return Math.max(1, this.es.ioQueuesPerPath.value);
  }

  // ── StorageBackend ────────────────────────────────────────────────────────

  attach(cluster: ClusterView): void {
    const eps = cluster.cvmStorageEndpoints(this.cvm);
    if (this.rebuild && eps.length > 0) this.setPaths(this.rebuild(eps));
  }

  /** NVMe Reservation Acquire (preempt): this CVM's Stargate takes the vDisk (Bible 8c). */
  acquire(vdisk: string, ctx: Ctx): void {
    this.queueCmd({ type: 'resv', vdisk, action: 'acquire' }, `resv:${vdisk}:${ctx.now}:a`, ctx);
  }

  release(vdisk: string, ctx: Ctx): void {
    this.reservations.delete(vdisk);
    this.queueCmd({ type: 'resv', vdisk, action: 'release' }, `resv:${vdisk}:${ctx.now}:r`, ctx);
  }

  submit(req: IoRequest, ctx: Ctx): void {
    if (this.paths.length > 0 && this.paths.every((p) => p.state === 'removed')) {
      this.completions.push({
        req,
        outcome: { status: 'error', reason: 'every NVMe controller has been deleted' },
        completedAt: ctx.now,
      });
      return;
    }
    this.queueCmd({ type: 'io', req }, req.id, ctx);
  }

  drain(): readonly IoCompletion[] {
    const out = this.completions;
    this.completions = [];
    return out;
  }

  health(): 'ok' | 'degraded' | 'unavailable' {
    const live = this.liveCount();
    if (live === 0) return 'unavailable';
    return live === this.paths.length ? 'ok' : 'degraded';
  }

  /** NVMe path ids that carried this vDisk's IO during the last tick. */
  pathsFor(vdisk: string): readonly string[] {
    return [...(this.lastUsage.paths.get(vdisk) ?? [])].sort();
  }

  /** Physical NICs (bond members) its IO egressed on during the last tick. */
  uplinksFor(vdisk: string): readonly string[] {
    return [...(this.lastUsage.uplinks.get(vdisk) ?? [])].sort();
  }

  /** Read-only path states, in configuration order. */
  pathStates(): Readonly<Record<string, PathState>> {
    return Object.fromEntries(this.paths.map((p) => [p.id, p.state]));
  }

  /** Commands outstanding, by state (inspector, tests). */
  outstanding(): Readonly<Record<'queued' | 'inflight' | 'held', number>> {
    const out = { queued: 0, inflight: 0, held: 0 };
    for (const c of this.cmds.values()) out[c.state]++;
    return out;
  }

  /** Last successful admin exchange per live path (tests, inspector). */
  lastExchange(pathId: string): SimTime | null {
    return this.paths.find((p) => p.id === pathId)?.lastOkAt ?? null;
  }

  holdsReservation(vdisk: string): boolean {
    return this.reservations.has(vdisk);
  }

  // ── CvmComponent hooks ────────────────────────────────────────────────────

  /** Time-driven transitions run first, so their retries go out in this tick's emit. */
  preTick(c: Ctx): void {
    const ctx = asEngineContext(c);
    this.causes.observe(ctx.prev);
    const now = ctx.now;
    for (const p of this.paths) {
      if (p.state === 'live' && now - p.lastOkAt >= this.kato) this.lose(p, ctx, 'silent');
      if (
        p.state === 'lost' &&
        p.lostAt !== null &&
        this.ctrlLoss !== RECONNECT_FOREVER &&
        now - p.lostAt >= this.ctrlLoss
      ) {
        this.remove(p, ctx);
      }
    }
    const timedOut = new Map<string, number>();
    for (const cmd of this.cmds.values()) {
      if (cmd.state === 'held' && now >= cmd.holdUntil) {
        this.requeue(cmd, cmd.path);
      } else if (
        cmd.state === 'inflight' &&
        cmd.path !== null &&
        this.path(cmd.path)?.state === 'live' &&
        now - cmd.startedAt >= this.ioTimeout
      ) {
        timedOut.set(cmd.path, (timedOut.get(cmd.path) ?? 0) + 1);
        this.requeue(cmd, cmd.path);
      }
    }
    for (const [pathId, n] of timedOut) {
      ctx.emit({
        severity: 'warn',
        deviceId: this.cvm,
        code: 'nvme.io.timeout',
        text: `${n} command(s) on ${pathId} got no completion in ${this.ioTimeout}s: aborted and retried`,
        causeIds: this.causes.causeOf(this.path(pathId)?.lastDropAt),
        cite: this.es.ioTimeoutS.cite,
        confidence: this.es.ioTimeoutS.confidence,
      });
    }
    if (this.paths.length > 0 && this.paths.every((p) => p.state === 'removed')) {
      this.failAll(ctx);
    }
  }

  emit(c: Ctx): void {
    const ctx = asEngineContext(c);
    const now = ctx.now;
    for (const p of this.paths) {
      if (p.state === 'live') {
        if (p.ka?.resend) p.ka = this.retransmit(p.ka, ctx);
        else if (p.ka === null && now >= p.nextKaAt)
          p.ka = this.sendAdmin(p, NVME_MSG.keepAlive, ctx);
        while (p.nextKaAt <= now) p.nextKaAt += this.kato / 2;
      } else if (p.state === 'lost' && p.nextReconnectAt !== null && now >= p.nextReconnectAt) {
        this.newAssociation(p);
        p.connect = this.sendAdmin(p, NVME_MSG.connect, ctx);
        p.nextReconnectAt = now + this.reconnectDelay;
        ctx.emit({
          severity: 'debug',
          deviceId: this.cvm,
          code: 'nvme.path.reconnect',
          text: `${p.id}: reconnect attempt`,
          causeIds: [],
          cite: this.es.reconnectDelayS.cite,
          confidence: this.es.reconnectDelayS.confidence,
        });
      }
    }
    for (const cmd of this.cmds.values()) {
      if (cmd.state === 'queued') this.dispatch(cmd, ctx);
      else if (cmd.state === 'inflight' && cmd.wire?.resend) {
        cmd.wire = this.retransmit(cmd.wire, ctx);
        cmd.delayed = true;
        this.noteUsage(cmd, ctx);
      }
    }
  }

  onMessage(msg: Message, c: Ctx): boolean {
    const ctx = asEngineContext(c);
    switch (msg.kind) {
      case NVME_MSG.keepAliveResp: {
        const pl = msg.payload as AdminPayload;
        const p = this.path(pl.pathId);
        if (p?.state === 'live' && pl.gen === p.gen) {
          p.lastOkAt = ctx.now;
          p.ka = null;
        }
        return true;
      }
      case NVME_MSG.connectResp: {
        const pl = msg.payload as ConnectRespPayload;
        const p = this.path(pl.pathId);
        if (p?.state === 'lost' && pl.gen === p.gen && pl.ok) this.restore(p, ctx);
        return true;
      }
      case NVME_MSG.ioResp:
      case NVME_MSG.resvResp: {
        const pl = msg.payload as CommandRespPayload;
        const [id, attempt] = splitKey(pl.key);
        const cmd = this.cmds.get(id);
        if (cmd && cmd.state === 'inflight' && cmd.attempt === attempt) {
          this.complete(cmd, pl, ctx.trace(msg.id), ctx);
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** Learn each frame's fate from its trace: refused → fast loss, silently dropped → retransmit. */
  tick(c: Ctx): void {
    const ctx = asEngineContext(c);
    for (const p of this.paths) {
      if (p.ka) {
        const fate = this.fate(p.ka, p, ctx);
        // Still outstanding here means unanswered: retransmit (a lost reply is retried too).
        if (fate === 'refused') this.lose(p, ctx, 'refused');
        else if (fate !== 'pending') p.ka.resend = true;
      }
      if (p.connect) {
        // A connect that was not answered this tick failed; the next attempt is on schedule.
        const fate = this.fate(p.connect, p, ctx);
        if (fate !== 'pending') p.connect = null;
      }
    }
    for (const cmd of this.cmds.values()) {
      if (cmd.state !== 'inflight' || cmd.wire === null || cmd.path === null) continue;
      const p = this.path(cmd.path);
      if (!p) continue;
      const fate = this.fate(cmd.wire, p, ctx);
      if (fate === 'refused') this.lose(p, ctx, 'refused');
      else if (fate === 'dropped') {
        cmd.wire.resend = true;
        if (p.state === 'live') cmd.stuck = true;
      }
    }
    this.settleUsage(ctx);
    this.armTimer(ctx);
  }

  onFail(): void {
    // The CVM (and Stargate) went down: outstanding commands die with it; the cluster layer
    // re-issues the guest's IO elsewhere. Paths reconnect on recovery.
    this.cmds.clear();
    this.blocked.clear();
    this.completions = [];
    this.usageWires = [];
    this.usage = emptyUsage();
    this.lastUsage = emptyUsage();
    this.timer = null;
    for (const p of this.paths) {
      p.state = 'lost';
      p.ka = null;
      p.connect = null;
      p.lostAt = null;
      p.nextReconnectAt = null;
    }
  }

  /** SPDK restarts with the CVM and connects every controller again. */
  onRecover(c: Ctx): void {
    const now = c.now;
    for (const p of this.paths) {
      p.state = 'lost';
      p.lostAt = now;
      p.nextReconnectAt = now;
    }
    this.allLostAnnounced = true;
    this.allRemovedAnnounced = false;
  }

  viewFields(): Readonly<Record<string, ViewField>> {
    const o = this.outstanding();
    return {
      nvmePathsUp: this.liveCount(),
      nvmePathsTotal: this.paths.length,
      nvmePaths: JSON.stringify(this.pathStates()),
      nvmeMultipathPolicy: this.policy,
      nvmePathSelector: this.selector,
      nvmeHealth: this.health(),
      nvmeIoInflight: o.inflight,
      nvmeIoHeld: o.held,
      nvmeIoQueued: o.queued,
      nvmeReservations: JSON.stringify([...this.reservations].sort()),
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private setPaths(cfg: readonly NvmePathConfig[]): void {
    this.paths = cfg.map((c) => {
      const p: Path = {
        id: pathIdOf(c.local, c.remote),
        local: c.local,
        remote: c.remote,
        // Connected before the scenario starts (steady state at t=0).
        state: 'live',
        gen: 0,
        adminPort: 0,
        ioPorts: [],
        nextQueue: 0,
        lastOkAt: 0,
        nextKaAt: 0,
        ka: null,
        connect: null,
        lostAt: null,
        nextReconnectAt: null,
        lastDropAt: undefined,
      };
      this.newAssociation(p);
      return p;
    });
    const byLocal = new Map<string, Path[]>();
    for (const p of this.paths) {
      const g = byLocal.get(p.local);
      if (g) g.push(p);
      else byLocal.set(p.local, [p]);
    }
    const groups = [...byLocal.values()];
    const width = Math.max(0, ...groups.map((g) => g.length));
    this.order = [];
    for (let k = 0; k < width; k++) {
      for (const g of groups) {
        const p = g[k];
        if (p) this.order.push(p);
      }
    }
  }

  /** A new association gets fresh ephemeral source ports (so LACP may hash it differently). */
  private newAssociation(p: Path): void {
    p.gen++;
    const port = () => EPHEMERAL_BASE + (this.portSeq++ % EPHEMERAL_SPAN);
    p.adminPort = port();
    p.ioPorts = Array.from({ length: this.queues }, port);
    p.nextQueue = 0;
  }

  private path(id: string): Path | undefined {
    return this.paths.find((p) => p.id === id);
  }

  private liveCount(): number {
    return this.paths.filter((p) => p.state === 'live').length;
  }

  private queueCmd(body: CmdBody, id: string, c: Ctx): void {
    const cmd: Cmd = {
      id,
      body,
      attempt: 0,
      state: 'queued',
      path: null,
      startedAt: c.now,
      holdUntil: 0,
      wire: null,
      avoid: null,
      delayed: false,
      stuck: false,
    };
    this.cmds.set(id, cmd);
    this.dispatch(cmd, asEngineContext(c));
  }

  private requeue(cmd: Cmd, avoid: string | null): void {
    cmd.state = 'queued';
    cmd.attempt++;
    cmd.avoid = avoid;
    cmd.wire = null;
    cmd.delayed = true;
    cmd.stuck = false;
  }

  private vdiskOf(cmd: Cmd): string {
    return cmd.body.type === 'io' ? cmd.body.req.vdisk : cmd.body.vdisk;
  }

  /** Round-robin closed loop: the first live path holding a stuck command of `vdisk`. */
  private sinkFor(vdisk: string): Path | undefined {
    for (const c of this.cmds.values()) {
      if (c.state !== 'inflight' || !c.stuck || c.path === null || this.vdiskOf(c) !== vdisk) {
        continue;
      }
      const p = this.path(c.path);
      if (p?.state === 'live') return p;
    }
    return undefined;
  }

  /** Outstanding (in-flight) commands per path, all vDisks (SPDK counts per qpair). */
  private loadByPath(): Map<string, number> {
    const n = new Map<string, number>();
    for (const c of this.cmds.values()) {
      if (c.state === 'inflight' && c.path !== null) n.set(c.path, (n.get(c.path) ?? 0) + 1);
    }
    return n;
  }

  /** Multipath policy and selector (SPEC §6.4b; policy `assumption`, selector `inferred`). */
  private choose(vdisk: string, avoid: string | null): Path | null {
    const live = this.order.filter((p) => p.state === 'live');
    if (live.length === 0) return null;
    const ok = (p: Path) => p.id !== avoid || live.length === 1;
    if (this.policy === 'active-active') {
      const i = this.rr.get(vdisk) ?? hash(vdisk);
      this.rr.set(vdisk, i + 1);
      if (this.selector === 'queue-depth') {
        // Fewest outstanding commands; ties go to the next path in turn.
        const load = this.loadByPath();
        let best: Path | null = null;
        let bestN = Number.POSITIVE_INFINITY;
        for (let k = 0; k < live.length; k++) {
          const p = live[(i + k) % live.length] as Path;
          const n = load.get(p.id) ?? 0;
          if (ok(p) && n < bestN) {
            best = p;
            bestN = n;
          }
        }
        return best;
      }
      // Round-robin across every live (ANA Optimized) path; a closed-loop guest's slots all end
      // up on a path that does not complete (see the header).
      const sink = this.sinkFor(vdisk);
      if (sink && ok(sink)) return sink;
      let pick = live[i % live.length] as Path;
      if (!ok(pick)) pick = live[(i + 1) % live.length] as Path;
      return pick;
    }
    // Active-passive: one sticky path per vDisk, vDisks spread by hash; fail over on loss.
    const cur = this.path(this.active.get(vdisk) ?? '');
    if (cur?.state === 'live' && ok(cur)) return cur;
    const start = hash(vdisk) % this.paths.length;
    for (let k = 0; k < this.paths.length; k++) {
      const p = this.paths[(start + k) % this.paths.length] as Path;
      if (p.state === 'live' && ok(p)) {
        this.active.set(vdisk, p.id);
        return p;
      }
    }
    return null;
  }

  private dispatch(cmd: Cmd, ctx: EngineTickContext<Profile>): void {
    const vdisk = this.vdiskOf(cmd);
    const until = cmd.body.type === 'io' ? this.blocked.get(vdisk) : undefined;
    if (until !== undefined) {
      if (ctx.now < until) {
        // Round-robin closed loop: every guest slot is held on the lost path (see the header).
        cmd.delayed = true;
        return;
      }
      this.blocked.delete(vdisk);
    }
    const p = this.choose(vdisk, cmd.avoid);
    if (!p) return; // no live path: stays queued, retried every tick (DEPLOY-GUIDE)
    const q = p.nextQueue++ % p.ioPorts.length;
    const write = cmd.body.type === 'io' && cmd.body.req.op === 'write';
    const payload: CommandPayload =
      cmd.body.type === 'io'
        ? {
            type: 'io',
            key: `${cmd.id}#${cmd.attempt}`,
            host: this.cvm,
            vdisk,
            op: cmd.body.req.op,
            size: cmd.body.req.size,
          }
        : {
            type: 'resv',
            key: `${cmd.id}#${cmd.attempt}`,
            host: this.cvm,
            vdisk,
            action: cmd.body.action,
          };
    const draft: MessageDraft<CommandPayload> = {
      kind: cmd.body.type === 'io' ? NVME_MSG.io : NVME_MSG.resv,
      src: p.local,
      dst: p.remote,
      // Write data rides the command; read data rides the completion.
      size: write && cmd.body.type === 'io' ? cmd.body.req.size : 'small',
      flow: ctx.flow(p.local, p.remote, { srcPort: p.ioPorts[q] ?? 0, dstPort: NVME_TCP_PORT }),
      payload,
      causeId: cmd.body.type === 'io' ? cmd.body.req.id : cmd.id,
    };
    cmd.state = 'inflight';
    cmd.path = p.id;
    cmd.startedAt = ctx.now;
    cmd.avoid = null;
    cmd.stuck = false;
    cmd.wire = { msgId: ctx.send(draft), sentAt: ctx.now, draft, resend: false };
    this.noteUsage(cmd, ctx);
  }

  private sendAdmin(p: Path, kind: string, ctx: EngineTickContext<Profile>): Wire {
    const payload: AdminPayload = { pathId: p.id, gen: p.gen, host: this.cvm };
    const draft: MessageDraft<AdminPayload> = {
      kind,
      src: p.local,
      dst: p.remote,
      size: 'small',
      flow: ctx.flow(p.local, p.remote, { srcPort: p.adminPort, dstPort: NVME_TCP_PORT }),
      payload,
    };
    return { msgId: ctx.send(draft), sentAt: ctx.now, draft, resend: false };
  }

  private retransmit(w: Wire, ctx: EngineTickContext<Profile>): Wire {
    return { msgId: ctx.send(w.draft), sentAt: ctx.now, draft: w.draft, resend: false };
  }

  /**
   * Fate of a frame. `refused`: it reached the target device but the endpoint is down, i.e. the
   * target actively closed or refused the connection (`inferred`). A frame sent late in a tick is
   * delivered in the next one, so a missing trace is only conclusive one tick later.
   */
  private fate(
    w: Wire,
    p: Path,
    ctx: EngineTickContext<Profile>,
  ): 'delivered' | 'dropped' | 'refused' | 'pending' {
    const t = ctx.trace(w.msgId);
    if (!t) return ctx.now - w.sentAt > 1 ? 'dropped' : 'pending';
    if (t.result === 'delivered') return 'delivered';
    p.lastDropAt = t.dropAt;
    const owner = ctx.net.endpoint(p.remote)?.owner;
    return t.reason === 'endpoint-down' && owner !== undefined && t.dropAt === owner
      ? 'refused'
      : 'dropped';
  }

  private lose(p: Path, ctx: EngineTickContext<Profile>, how: 'silent' | 'refused'): void {
    if (p.state !== 'live') return;
    const now = ctx.now;
    p.state = 'lost';
    p.lostAt = now;
    p.nextReconnectAt = now + this.reconnectDelay;
    p.ka = null;
    p.connect = null;
    const silent = how === 'silent';
    // NVMe 2.1 §9.6.2–9.6.3: before retrying elsewhere, wait until the controller must have seen
    // the loss (k × KATO after the last exchange), then CQT. A target-closed connection skips the
    // first wait (step 2c).
    const holdUntil = silent
      ? Math.max(now + 1, p.lastOkAt + this.silentHoldS)
      : now + Math.max(1, this.cqt);
    let held = 0;
    for (const cmd of this.cmds.values()) {
      if (cmd.state === 'inflight' && cmd.path === p.id) {
        // Round-robin closed loop: a vDisk whose slots migrated here has none left to issue from.
        if (this.selector === 'round-robin' && cmd.stuck) {
          this.blocked.set(this.vdiskOf(cmd), holdUntil);
        }
        cmd.state = 'held';
        cmd.holdUntil = holdUntil;
        cmd.wire = null;
        cmd.delayed = true;
        cmd.stuck = false;
        held++;
      }
    }
    const remoteOwner = ctx.net.endpoint(p.remote)?.owner;
    const causeIds = this.causes.causeOf(p.lastDropAt, remoteOwner, p.remote);
    const rule = silent
      ? `${this.es.lostPathHoldKatoMultiplier.value} × KATO + CQT after the last exchange`
      : 'CQT';
    const heldText = held
      ? `; ${held} in-flight command(s) held until t=${holdUntil} (${rule})`
      : '';
    const ev = ctx.emit({
      severity: 'warn',
      deviceId: this.cvm,
      code: 'nvme.path.lost',
      text: silent
        ? `${p.id} lost: no keep-alive response for ${this.kato}s${heldText}`
        : `${p.id} lost: connection refused by the target${heldText}`,
      causeIds,
      cite: silent
        ? [
            ...new Set([
              ...this.es.keepAliveTimeoutS.cite,
              ...this.es.lostPathHoldKatoMultiplier.cite,
              ...this.es.commandQuiesceTimeS.cite,
            ]),
          ]
        : (['nvme-base-spec-2.1', 'nvme-tcp-spec'] satisfies KnownCitationId[]),
      confidence: silent ? this.es.keepAliveTimeoutS.confidence : 'inferred',
    });
    if (this.liveCount() === 0 && !this.allLostAnnounced) {
      this.allLostAnnounced = true;
      ctx.emit({
        severity: 'error',
        deviceId: this.cvm,
        code: 'nvme.all-paths.lost',
        text: `${this.cvm} has no live NVMe path: IO is queued and retried until the array responds`,
        causeIds: [ev],
        cite: this.es.pathLossDefault.cite,
        confidence: this.es.pathLossDefault.confidence,
      });
    }
  }

  private restore(p: Path, ctx: EngineTickContext<Profile>): void {
    p.state = 'live';
    p.lastOkAt = ctx.now;
    p.nextKaAt = ctx.now + this.kato / 2;
    p.lostAt = null;
    p.nextReconnectAt = null;
    p.connect = null;
    p.ka = null;
    this.allLostAnnounced = false;
    ctx.emit({
      severity: 'info',
      deviceId: this.cvm,
      code: 'nvme.path.restored',
      text: `${p.id} reconnected (ANA Optimized); IO rebalances onto it`,
      causeIds: [],
      cite: this.es.reconnectDelayS.cite,
      confidence: this.es.reconnectDelayS.confidence,
    });
  }

  private remove(p: Path, ctx: EngineTickContext<Profile>): void {
    p.state = 'removed';
    p.nextReconnectAt = null;
    p.connect = null;
    ctx.emit({
      severity: 'error',
      deviceId: this.cvm,
      code: 'nvme.path.removed',
      text: `${p.id}: no reconnect within ${this.ctrlLoss}s, controller deleted`,
      causeIds: [],
      cite: this.es.controllerLossTimeoutS.cite,
      confidence: this.es.controllerLossTimeoutS.confidence,
    });
  }

  private failAll(ctx: EngineTickContext<Profile>): void {
    if (!this.allRemovedAnnounced) {
      this.allRemovedAnnounced = true;
      ctx.emit({
        severity: 'critical',
        deviceId: this.cvm,
        code: 'nvme.all-paths.removed',
        text: `${this.cvm}: every NVMe controller deleted; queued IO fails to the guest`,
        causeIds: [],
        cite: this.es.controllerLossTimeoutS.cite,
        confidence: this.es.controllerLossTimeoutS.confidence,
      });
    }
    for (const cmd of [...this.cmds.values()]) {
      this.cmds.delete(cmd.id);
      if (cmd.body.type !== 'io') continue;
      this.completions.push({
        req: cmd.body.req,
        outcome: { status: 'error', reason: 'every NVMe controller has been deleted' },
        completedAt: ctx.now,
      });
    }
  }

  private complete(
    cmd: Cmd,
    resp: CommandRespPayload,
    trace: EngineTrace | undefined,
    ctx: EngineTickContext<Profile>,
  ): void {
    this.cmds.delete(cmd.id);
    const body = cmd.body;
    if (body.type === 'resv') {
      if (resp.status === 'ok' && body.action === 'acquire') this.reservations.add(body.vdisk);
      return;
    }
    if (resp.status === 'reservation-conflict') {
      if (!this.conflictAnnounced.has(body.req.vdisk)) {
        this.conflictAnnounced.add(body.req.vdisk);
        ctx.emit({
          severity: 'warn',
          deviceId: this.cvm,
          code: 'nvme.io.reservation-conflict',
          text: `${body.req.vdisk}: IO rejected, another host holds the NVMe reservation (fenced)`,
          causeIds: [],
          cite: ['ntnx-bible-8c', 'nvme-base-spec'] satisfies KnownCitationId[],
          confidence: 'verified',
        });
      }
      this.completions.push({
        req: body.req,
        outcome: { status: 'error', reason: 'reservation-conflict' },
        completedAt: ctx.now,
      });
      return;
    }
    this.conflictAnnounced.delete(body.req.vdisk);
    const waitedS = cmd.delayed || resp.heldS > 0 ? ctx.now - body.req.issuedAt : 0;
    const latencyMs = waitedS * 1000 + resp.latencyMs + (trace?.latencyMs ?? 0);
    this.completions.push({
      req: body.req,
      outcome: { status: 'ok', latencyMs: Math.round(latencyMs * 1000) / 1000 },
      completedAt: ctx.now,
    });
  }

  private noteUsage(cmd: Cmd, ctx: EngineTickContext<Profile>): void {
    if (cmd.body.type !== 'io' || cmd.path === null || cmd.wire === null) return;
    addTo(this.usage.paths, cmd.body.req.vdisk, cmd.path);
    this.usageWires.push({
      vdisk: cmd.body.req.vdisk,
      path: cmd.path,
      msgId: cmd.wire.msgId,
      sentAt: ctx.now,
    });
  }

  /** Close this tick's path-usage record (uplinks come from each IO frame's egress NIC). */
  private settleUsage(ctx: EngineTickContext<Profile>): void {
    const keep: UsageWire[] = [];
    for (const u of this.usageWires) {
      const t = ctx.trace(u.msgId);
      if (t?.egress !== undefined) addTo(this.usage.uplinks, u.vdisk, t.egress);
      else if (!t && ctx.now - u.sentAt < 1) keep.push(u);
    }
    this.usageWires = keep;
    this.lastUsage = this.usage;
    this.usage = emptyUsage();
  }

  /** One engine timer at the next NVMe deadline, so "fast-forward to next timer" sees it. */
  private armTimer(ctx: EngineTickContext<Profile>): void {
    let due = Number.POSITIVE_INFINITY;
    for (const p of this.paths) {
      if (p.state === 'live') due = Math.min(due, p.lastOkAt + this.kato, Math.ceil(p.nextKaAt));
      if (p.state === 'lost') {
        if (p.nextReconnectAt !== null) due = Math.min(due, p.nextReconnectAt);
        if (p.lostAt !== null && this.ctrlLoss !== RECONNECT_FOREVER) {
          due = Math.min(due, p.lostAt + this.ctrlLoss);
        }
      }
    }
    for (const t of this.blocked.values()) due = Math.min(due, t);
    for (const c of this.cmds.values()) {
      if (c.state === 'held') due = Math.min(due, c.holdUntil);
      if (c.state === 'inflight') due = Math.min(due, c.startedAt + this.ioTimeout);
    }
    const at = Math.max(ctx.now + 1, due);
    if (!Number.isFinite(at)) return;
    if (
      this.timer &&
      this.timer.dueAt === at &&
      ctx.timers.pending().some((h) => h.id === this.timer?.id)
    ) {
      return;
    }
    if (this.timer) ctx.timers.cancel(this.timer);
    this.timer = ctx.timers.set(
      `nvme ${this.cvm}`,
      at - ctx.now,
      { cite: this.es.keepAliveTimeoutS.cite, confidence: this.es.keepAliveTimeoutS.confidence },
      () => {
        this.timer = null;
      },
    );
  }
}

function splitKey(key: string): [string, number] {
  const i = key.lastIndexOf('#');
  return [key.slice(0, i), Number(key.slice(i + 1))];
}
