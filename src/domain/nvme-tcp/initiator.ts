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
 *    Keep-alive is traffic-based: a completed IO command counts as an exchange.
 * 3. Until then the initiator cannot tell the path is dead, so the selector keeps giving it new IO
 *    (see "Path selection"). Once lost, new IO uses the live paths. Commands in flight on a silently
 *    lost path are retried on another path at `lostPathHoldKatoMultiplier × KATO + CQT` after its
 *    last successful exchange (§9.6.2–9.6.3: give the controller time to detect the loss, then CQT
 *    to quiesce); on a connection the target closed, CQT after the loss (§9.6.2 step 2c). Reads
 *    could retry at detection; the model holds all IO (conservative). A command stuck on a live but
 *    broken queue (hung bond member, lossy link, no carrier loss) is aborted after `ioTimeoutS`,
 *    retried on another path, and the path is reset (it reconnects after `reconnectDelayS`).
 *    After a silent loss the old connection is still probed; a TCP reset from the target (it tore
 *    the association down: its port lost link, or KATO passed in silence) releases the held
 *    commands at once (`targetResetRetryS`): a short port flap costs about its outage.
 * 4. A lost path reconnects every `reconnectDelayS`; after `controllerLossTimeoutS` its controller
 *    is deleted (`RECONNECT_FOREVER` = never).
 * 5. With no live path IO stays queued and is retried until the array responds (DEPLOY-GUIDE);
 *    it fails to the guest only once every path's controller is deleted.
 *
 * Path selection (`active-active`, SPEC §6.4b; SPDK bdev_nvme selectors):
 * - `queue-depth`: the live path with the fewest outstanding commands (ties in turn). A slower
 *   path drains more slowly, so it is eligible only every (its latency ÷ fastest)-th turn (Little's
 *   law). A silently dead path's IO queues look idle until each holds a command of the guest
 *   (closed loop, see `sinkFor`): a guest whose queue depth fits in them stalls completely until
 *   the hold expires; a deeper one stalls partially (stuck commands are latency outliers).
 * - `round-robin`: the next live path in turn. A queue-depth-bound guest re-issues each completed IO
 *   at once, and with sub-millisecond service times every one of its slots lands on the dead path
 *   within a fraction of a second. The model's few IOs per tick stand for that closed loop
 *   (`assumption`): once a vDisk has a command stuck on a path still believed live, its new IO goes
 *   to that path too, and once the path is declared lost, its new IO waits until the held commands
 *   are retried (the guest has no free slot to issue it from). A full stall, until the hold expires.
 *
 * TCP is abstracted: a frame the network dropped silently is retransmitted with a doubling timer
 * (RFC 6298 §5.5; 1, 1, 1, 2, 4, … s up to `tcpRtoMaxS`); keep-alives every second.
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
  type ResetPayload,
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
  /** Last IO completion on this path (data-plane liveness, as opposed to keep-alive). */
  lastIoOkAt: SimTime;
  /** Latest observed IO completion latency on this path, ms (null: none yet). */
  rttMs: number | null;
  /** Queue-depth selector: share credit of a slower path (see `choose`). */
  credit: number;
  /** How the path was last lost (null while live). */
  lostHow: LossHow | null;
  /** Association generation the held commands of a silent loss were sent on. */
  heldGen: number;
  /** TCP retransmission of the oldest held command on the old connection (silent loss only). */
  probe: { nextAt: SimTime; tries: number; wire: Wire | null } | null;
}

type LossHow = 'silent' | 'refused' | 'reset' | 'io-timeout';

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
  /** Association generation of the path when this attempt was sent. */
  gen: number;
  /** Retransmissions of the current attempt so far (TCP backoff). */
  tries: number;
  /** Earliest time the next retransmission may go out. */
  nextResendAt: SimTime;
  /** Held after a silent loss: a TCP reset from the target releases it early. */
  silentHeld: boolean;
  /** The frame of the current attempt (resent by the post-loss probe). */
  lastDraft: MessageDraft | null;
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
/** Rolling window of the per-path IO share view (a display choice, not vendor behavior). */
const SHARE_WINDOW_S = 30;
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
  /** Queue-depth closed loop: this tick's new commands per vDisk to a dead-path sink vs others. */
  private readonly tally = new Map<string, { sink: number; live: number }>();
  /** Round-robin: vDisk → time its new IO may go out again (its guest slots are all held). */
  private readonly blocked = new Map<string, SimTime>();
  private readonly reservations = new Set<string>();
  private readonly conflictAnnounced = new Set<string>();
  private usageWires: UsageWire[] = [];
  private usage: Usage = emptyUsage();
  private lastUsage: Usage = emptyUsage();
  /** IO dispatched per path, per tick, over the last `SHARE_WINDOW_S` ticks (path-share view). */
  private shareWindow: Map<string, number>[] = [];
  private shareNow = new Map<string, number>();
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
  /**
   * TCP retransmission wait before resend number `tries + 1` of the same frame (RFC 6298 §5.5:
   * the timer doubles on each retransmission). With 1 s ticks the sub-second first retries fold
   * into 1, 1, 1 s; then 2, 4, 8, … up to `tcpRtoMaxS`.
   */
  private rto(tries: number): number {
    if (tries < 3) return 1;
    return Math.max(1, Math.min(2 ** (tries - 2), this.es.tcpRtoMaxS.value));
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

  /** Every path is down and the target closed or reset each one (not a silent loss). */
  lostByTarget(): boolean {
    return (
      this.paths.length > 0 &&
      this.liveCount() === 0 &&
      this.paths.every((p) => p.lostHow === 'refused' || p.lostHow === 'reset')
    );
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
    this.tally.clear();
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
      const ev = ctx.emit({
        severity: 'warn',
        deviceId: this.cvm,
        code: 'nvme.io.timeout',
        text: `${n} command(s) on ${pathId} got no completion in ${this.ioTimeout}s: aborted and retried on another path; the path is reset and reconnects`,
        causeIds: this.causes.causeOf(this.path(pathId)?.lastDropAt),
        cite: this.es.ioTimeoutS.cite,
        confidence: this.es.ioTimeoutS.confidence,
      });
      // An IO timeout triggers error recovery: the host tears the association down and
      // reconnects (Linux nvme-tcp error recovery; `inferred` for Stargate).
      const p = this.path(pathId);
      if (p) this.lose(p, ctx, 'io-timeout', [ev]);
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
      else if (cmd.state === 'inflight' && cmd.wire?.resend && now >= cmd.nextResendAt) {
        cmd.wire = this.retransmit(cmd.wire, ctx);
        cmd.delayed = true;
        this.noteUsage(cmd, ctx);
      }
    }
    for (const p of this.paths) this.sendProbe(p, ctx);
  }

  /**
   * After a silent loss the host's TCP keeps retransmitting the oldest held command on the old
   * connection, with backoff. If the fabric is back and the target answers with a reset (it tore
   * the association down), every held command of the path is retried at once (`onReset`).
   */
  private sendProbe(p: Path, ctx: EngineTickContext<Profile>): void {
    const pr = p.probe;
    if (pr === null || pr.wire !== null || ctx.now < pr.nextAt) return;
    let oldest: Cmd | undefined;
    for (const c of this.cmds.values()) {
      if (c.state !== 'held' || !c.silentHeld || c.path !== p.id) continue;
      if (oldest === undefined || c.startedAt < oldest.startedAt) oldest = c;
    }
    if (oldest === undefined) {
      p.probe = null;
      return;
    }
    if (oldest.lastDraft === null) return;
    pr.wire = {
      msgId: ctx.send(oldest.lastDraft),
      sentAt: ctx.now,
      draft: oldest.lastDraft,
      resend: false,
    };
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
          const p = cmd.path === null ? undefined : this.path(cmd.path);
          if (p) this.noteIoOk(p, pl, ctx.trace(msg.id), ctx);
          this.complete(cmd, pl, ctx.trace(msg.id), ctx);
        } else if (cmd && cmd.state === 'held' && cmd.silentHeld && cmd.attempt === attempt) {
          // A probe on the old connection was served after all: that connection works again,
          // so the rest of the path's held commands are retried now rather than at the hold.
          const p = cmd.path === null ? undefined : this.path(cmd.path);
          this.complete(cmd, pl, ctx.trace(msg.id), ctx);
          if (p) this.releaseHeld(p, ctx.now);
        }
        return true;
      }
      case NVME_MSG.reset: {
        const p = this.path(pathIdOf(msg.dst, msg.src));
        if (p) this.onReset(p, (msg.payload as ResetPayload).gen, ctx);
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
      if (cmd.wire.resend) continue; // fate known, waiting for the retransmission timer
      const p = this.path(cmd.path);
      if (!p) continue;
      const fate = this.fate(cmd.wire, p, ctx);
      if (fate === 'refused') this.lose(p, ctx, 'refused');
      else if (fate === 'dropped') {
        cmd.wire.resend = true;
        cmd.nextResendAt = ctx.now + this.rto(cmd.tries);
        cmd.tries++;
        if (p.state === 'live') cmd.stuck = true;
      }
    }
    for (const p of this.paths) {
      const pr = p.probe;
      if (pr?.wire == null) continue;
      const fate = this.fate(pr.wire, p, ctx);
      if (fate === 'pending' || fate === 'delivered') {
        // Delivered: the target answers with a reset or a completion (onMessage).
        if (fate === 'delivered') {
          pr.wire = null;
          pr.nextAt = ctx.now + 1;
        }
        continue;
      }
      pr.wire = null;
      pr.nextAt = ctx.now + this.rto(pr.tries);
      pr.tries++;
    }
    this.shareWindow.push(this.shareNow);
    if (this.shareWindow.length > SHARE_WINDOW_S) this.shareWindow.shift();
    this.shareNow = new Map();
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
    this.shareWindow = [];
    this.shareNow = new Map();
    this.timer = null;
    for (const p of this.paths) {
      p.state = 'lost';
      p.ka = null;
      p.connect = null;
      p.lostAt = null;
      p.nextReconnectAt = null;
      p.probe = null;
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
      nvmePathLatencyMs: JSON.stringify(
        Object.fromEntries(
          this.paths.map((p) => [p.id, p.rttMs === null ? null : round3(p.rttMs)]),
        ),
      ),
      nvmePathIoShare: JSON.stringify(this.ioShare()),
    };
  }

  /** Share of this CVM's IO commands sent on each path over the last `SHARE_WINDOW_S` s, %. */
  ioShare(): Readonly<Record<string, number>> {
    const n = new Map<string, number>();
    let total = 0;
    for (const tick of this.shareWindow) {
      for (const [id, k] of tick) {
        n.set(id, (n.get(id) ?? 0) + k);
        total += k;
      }
    }
    return Object.fromEntries(
      this.paths.map((p) => [
        p.id,
        total === 0 ? 0 : Math.round((1000 * (n.get(p.id) ?? 0)) / total) / 10,
      ]),
    );
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
        lastIoOkAt: 0,
        rttMs: null,
        credit: 1,
        lostHow: null,
        heldGen: 0,
        probe: null,
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
      gen: 0,
      tries: 0,
      nextResendAt: 0,
      silentHeld: false,
      lastDraft: null,
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
    cmd.silentHeld = false;
    cmd.tries = 0;
  }

  private vdiskOf(cmd: Cmd): string {
    return cmd.body.type === 'io' ? cmd.body.req.vdisk : cmd.body.vdisk;
  }

  /**
   * Closed-loop sink (see the header): a path still believed live whose data plane is dead, i.e.
   * it holds a stuck command of `vdisk` and has completed no IO since that command went out (a
   * lossy path that still completes IO is no sink). Round-robin: every new command of the vDisk
   * goes there. Queue-depth: until the vDisk has one command on each of the path's IO queues;
   * after that the dead queues are deeper than the live ones and get no more.
   */
  private sinkFor(vdisk: string): Path | undefined {
    const perPath = new Map<string, number>();
    const dead: Path[] = [];
    for (const c of this.cmds.values()) {
      if (c.state !== 'inflight' || c.path === null || this.vdiskOf(c) !== vdisk) continue;
      perPath.set(c.path, (perPath.get(c.path) ?? 0) + 1);
      if (!c.stuck) continue;
      const p = this.path(c.path);
      if (p?.state === 'live' && p.lastIoOkAt < c.startedAt && !dead.includes(p)) dead.push(p);
    }
    if (this.selector === 'round-robin') return dead[0];
    return dead.find((p) => (perPath.get(p.id) ?? 0) < this.queues);
  }

  /** Commands of `vdisk` at the initiator that are not held (queued or in flight). */
  private outstandingOf(vdisk: string): number {
    let n = 0;
    for (const c of this.cmds.values()) {
      if (c.state !== 'held' && this.vdiskOf(c) === vdisk) n++;
    }
    return n;
  }

  /** Path latency the queue-depth selector weighs (network + array service), ms. */
  private latencyOf(p: Path, fallback: number): number {
    return Math.max(0.001, p.rttMs ?? fallback);
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
        // A dead queue at depth 0 ties with the live ones, so the guest's re-issued IO lands on
        // each dead queue within moments (sub-millisecond closed loop). A guest whose outstanding
        // IO fits in the dead queues ends up with every slot there; a deeper one keeps IO
        // flowing on the live paths every tick while the dead queues fill.
        const tally = this.tally.get(vdisk) ?? { sink: 0, live: 0 };
        this.tally.set(vdisk, tally);
        const sink = this.sinkFor(vdisk);
        if (sink && ok(sink) && (tally.live > 0 || this.outstandingOf(vdisk) <= this.queues)) {
          tally.sink++;
          return sink;
        }
        tally.live++;
        // Fewest outstanding commands; ties go to the next path in turn. A slower path drains
        // its queue more slowly, so it holds more commands and gets proportionally less new IO
        // (Little's law): it is eligible only every (its latency ÷ fastest latency)-th turn.
        const known = live.flatMap((p) => (p.rttMs === null ? [] : [p.rttMs]));
        const base = known.length > 0 ? Math.min(...known) : 1;
        const fastest = Math.min(...live.map((p) => this.latencyOf(p, base)));
        for (const p of live) p.credit = Math.min(1, p.credit + fastest / this.latencyOf(p, base));
        const load = this.loadByPath();
        let best: Path | null = null;
        let bestN = Number.POSITIVE_INFINITY;
        for (const weighted of [true, false]) {
          for (let k = 0; k < live.length; k++) {
            const p = live[(i + k) % live.length] as Path;
            const n = load.get(p.id) ?? 0;
            if (ok(p) && (!weighted || p.credit >= 1 - 1e-9) && n < bestN) {
              best = p;
              bestN = n;
            }
          }
          if (best !== null) break;
        }
        if (best !== null) best.credit = Math.max(0, best.credit - 1);
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
            gen: p.gen,
            host: this.cvm,
            vdisk,
            op: cmd.body.req.op,
            size: cmd.body.req.size,
          }
        : {
            type: 'resv',
            key: `${cmd.id}#${cmd.attempt}`,
            gen: p.gen,
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
    cmd.gen = p.gen;
    cmd.tries = 0;
    cmd.nextResendAt = 0;
    cmd.lastDraft = draft;
    cmd.wire = { msgId: ctx.send(draft), sentAt: ctx.now, draft, resend: false };
    if (cmd.body.type === 'io') this.shareNow.set(p.id, (this.shareNow.get(p.id) ?? 0) + 1);
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

  /**
   * Declare a path lost. What happens to its in-flight commands depends on how (SPEC §6.4c):
   * - `silent` (keep-alive timeout): held until k × KATO + CQT after the last exchange (NVMe 2.1
   *   §9.6.2–9.6.3), while the old connection is probed; a target reset releases them early.
   * - `refused` (the target closed the connection): held CQT (§9.6.2 step 2c).
   * - `reset` (the target reset a connection it had already torn down): retried after
   *   `targetResetRetryS`.
   * - `io-timeout` (the host's own error recovery after an IO timeout): retried at once.
   */
  private lose(
    p: Path,
    ctx: EngineTickContext<Profile>,
    how: LossHow,
    extraCauses: readonly string[] = [],
  ): void {
    if (p.state !== 'live') return;
    const now = ctx.now;
    p.state = 'lost';
    p.lostAt = now;
    p.lostHow = how;
    p.nextReconnectAt = now + this.reconnectDelay;
    p.ka = null;
    p.connect = null;
    const silent = how === 'silent';
    const holdUntil = silent
      ? Math.max(now + 1, p.lastOkAt + this.silentHoldS)
      : how === 'refused'
        ? now + Math.max(1, this.cqt)
        : now + this.es.targetResetRetryS.value;
    let held = 0;
    let retried = 0;
    let tries = 0;
    for (const cmd of this.cmds.values()) {
      if (cmd.state !== 'inflight' || cmd.path !== p.id) continue;
      if (how === 'io-timeout' || (how === 'reset' && holdUntil <= now)) {
        this.requeue(cmd, p.id);
        retried++;
        continue;
      }
      // Round-robin closed loop: a vDisk whose slots migrated here has none left to issue from.
      if (this.selector === 'round-robin' && cmd.stuck) {
        this.blocked.set(this.vdiskOf(cmd), holdUntil);
      }
      tries = Math.max(tries, cmd.tries);
      cmd.state = 'held';
      cmd.holdUntil = holdUntil;
      cmd.wire = null;
      cmd.delayed = true;
      cmd.stuck = false;
      cmd.silentHeld = silent;
      held++;
    }
    if (silent && held > 0) {
      p.heldGen = p.gen;
      p.probe = { nextAt: now + this.rto(tries), tries: tries + 1, wire: null };
    } else p.probe = null;
    const remoteOwner = ctx.net.endpoint(p.remote)?.owner;
    const causeIds = [...extraCauses, ...this.causes.causeOf(p.lastDropAt, remoteOwner, p.remote)];
    const rule = silent
      ? `${this.es.lostPathHoldKatoMultiplier.value} × KATO + CQT after the last exchange, or earlier if the target resets the old connection`
      : 'CQT';
    const heldText = held
      ? `; ${held} in-flight command(s) held until t=${holdUntil} (${rule})`
      : retried
        ? `; ${retried} in-flight command(s) retried on another path now`
        : '';
    const text: Record<LossHow, string> = {
      silent: `${p.id} lost: no keep-alive response for ${this.kato}s${heldText}`,
      refused: `${p.id} lost: connection refused by the target${heldText}`,
      reset: `${p.id} lost: the target reset the connection (it had already dropped the association)${heldText}; reconnecting`,
      'io-timeout': `${p.id} reset after an IO timeout${heldText}; reconnect in ${this.reconnectDelay}s`,
    };
    const cite: Record<LossHow, readonly string[]> = {
      silent: [
        ...new Set([
          ...this.es.keepAliveTimeoutS.cite,
          ...this.es.lostPathHoldKatoMultiplier.cite,
          ...this.es.commandQuiesceTimeS.cite,
        ]),
      ],
      refused: ['nvme-base-spec-2.1', 'nvme-tcp-spec'] satisfies KnownCitationId[],
      reset: this.es.targetResetRetryS.cite,
      'io-timeout': this.es.ioTimeoutS.cite,
    };
    const ev = ctx.emit({
      severity: 'warn',
      deviceId: this.cvm,
      code: 'nvme.path.lost',
      text: text[how],
      causeIds,
      cite: cite[how],
      confidence: silent
        ? this.es.keepAliveTimeoutS.confidence
        : how === 'reset'
          ? this.es.targetResetRetryS.confidence
          : 'inferred',
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

  /** TCP reset from the target on `p` (a frame of an association it no longer has). */
  private onReset(p: Path, gen: number, ctx: EngineTickContext<Profile>): void {
    // A reset of the current association loses the path; one of an older association (a probe
    // on the connection a reconnect replaced) only releases the commands still held on it.
    if (p.state === 'live' && gen === p.gen) {
      this.lose(p, ctx, 'reset');
      return;
    }
    const n = this.releaseHeld(p, ctx.now);
    if (n === 0) return;
    ctx.emit({
      severity: 'info',
      deviceId: this.cvm,
      code: 'nvme.io.released',
      text: `${p.id}: the target reset the old connection, so it holds none of the ${n} stuck command(s); retried on another path now instead of waiting out the hold`,
      causeIds: this.causes.causeOf(p.remote, ctx.net.endpoint(p.remote)?.owner),
      cite: this.es.targetResetRetryS.cite,
      confidence: this.es.targetResetRetryS.confidence,
    });
  }

  /** Retry the commands held after a silent loss of `p` (`targetResetRetryS` from now). */
  private releaseHeld(p: Path, now: SimTime): number {
    const retryAt = now + this.es.targetResetRetryS.value;
    let n = 0;
    for (const cmd of this.cmds.values()) {
      if (cmd.state !== 'held' || !cmd.silentHeld || cmd.path !== p.id) continue;
      n++;
      if (this.blocked.has(this.vdiskOf(cmd))) this.blocked.set(this.vdiskOf(cmd), retryAt);
      if (retryAt <= now) this.requeue(cmd, p.id);
      else {
        cmd.holdUntil = Math.min(cmd.holdUntil, retryAt);
        cmd.silentHeld = false;
      }
    }
    p.probe = null;
    return n;
  }

  /** An IO completed on `p`: its data plane works; remember its latency for the selector. */
  private noteIoOk(
    p: Path,
    resp: CommandRespPayload,
    trace: EngineTrace | undefined,
    ctx: EngineTickContext<Profile>,
  ): void {
    p.lastIoOkAt = ctx.now;
    p.rttMs = resp.latencyMs + (trace?.latencyMs ?? 0);
    // Traffic-based keep-alive (NVMe 2.1 §3.9.3.1.2; the same mode the lost-path hold assumes):
    // a completed command restarts the keep-alive timer, so a lossy path that still completes IO
    // is not declared lost even when a keep-alive goes astray.
    p.lastOkAt = Math.max(p.lastOkAt, ctx.now);
  }

  private restore(p: Path, ctx: EngineTickContext<Profile>): void {
    p.state = 'live';
    p.lostHow = null;
    p.credit = 1;
    // The reconnect replaced the old association at the target: probe the old connection at once,
    // so the target's reset releases any commands still held from a silent loss.
    if (p.probe !== null) {
      p.probe.nextAt = ctx.now;
      p.probe.wire = null;
    }
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
      if (p.probe !== null && p.probe.wire === null) due = Math.min(due, p.probe.nextAt);
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
      if (c.state === 'inflight' && c.wire?.resend) due = Math.min(due, c.nextResendAt);
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

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function splitKey(key: string): [string, number] {
  const i = key.lastIndexOf('#');
  return [key.slice(0, i), Number(key.slice(i + 1))];
}
