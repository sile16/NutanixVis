/**
 * Everpure FlashArray controller HA and NVMe/TCP target state (SPEC §6.4, §6.4a T1 rows). Shared by
 * the `fa-array`, `fa-controller` and `fa-interface` devices; every value is read from
 * `profile.flasharray.*` / `profile.externalStorage.*`.
 *
 * Purity HA (Everpure "HA Failover Explained", "HA Timing Objectives", and the per-case KBs):
 * - The primary holds the drive-quorum claim. Both controllers' front-end ports serve IO; the
 *   secondary forwards to the primary, so IO completes only while a primary is serving.
 * - Primary crash: the secondary sees the claim expire after `claimExpiryDetectS`, then promotes.
 *   The whole array pauses for `primaryCrashPauseS`, bounded by detection + `promotionMaxS`.
 * - Secondary crash: no array-wide pause; only its ports (paths) go away.
 * - Primary IO stall: an IO outstanding for `ioDelayTimeoutS` triggers a giveback, then the peer
 *   promotes (pause = delay + promotion, inside `failoverObjectiveS`).
 * - Planned failover: giveback, then promotion, with a `plannedFailoverPauseS` pause.
 * - NDU (Everpure "Performing the Upgrade"): reboot the secondary (ports gone for
 *   `controllerRebootS`: no NPIV for Ethernet/NVMe), fail over, reboot the old primary. No
 *   failback (SPEC §14 #2).
 * - The mgmt VIP follows the primary (DEPLOY-GUIDE Tables 3 and 10).
 */
import type {
  Confidence,
  DeviceId,
  EndpointId,
  EventDraft,
  Message,
  SimTime,
} from '../../engine/types';
import type { KnownCitationId } from '../citations';
import {
  type CommandPayload,
  type CommandRespPayload,
  type CommandStatus,
  NVME_MSG,
  type ReplyDraft,
} from '../nvme-tcp/protocol';
import type { Profile } from '../versions/profile';
import type { FaFacts } from './facts';

export type FaRole = 'primary' | 'secondary' | 'promoting' | 'offline';
export type FaState = 'up' | 'crashed' | 'rebooting' | 'stalled';

/**
 * Illustrative array service time added to completions (never drives timing). `assumption`: no
 * per-IO figure is modeled; a profile field is requested.
 */
export const FA_SERVICE_MS = { read: 0.2, write: 0.15 } as const;

/** What a model transition may do; implemented by device contexts and action contexts. */
export interface FaEnv {
  readonly now: SimTime;
  emit(e: EventDraft): string;
  setEndpointUp(id: EndpointId, up: boolean, causes: readonly string[]): void;
  moveEndpoint(id: EndpointId, nic: string, causes: readonly string[]): void;
}

export interface ControllerState {
  readonly id: DeviceId;
  readonly label: string;
  readonly slot: 'ct0' | 'ct1';
  readonly mgmtNic: string | null;
  readonly interfaces: readonly EndpointId[];
  role: FaRole;
  state: FaState;
  stalledAt: SimTime | null;
  rebootUntil: SimTime | null;
  /** Host endpoint → time of its last admin exchange (connect/keep-alive) on this controller. */
  readonly hosts: Map<EndpointId, SimTime>;
}

interface Promotion {
  readonly ctrl: DeviceId;
  readonly until: SimTime;
  readonly causes: readonly string[];
}

interface Held {
  readonly ctrl: DeviceId;
  readonly msg: Message<CommandPayload>;
  readonly receivedAt: SimTime;
  readonly reqLatencyMs: number;
}

export type Reply = ReplyDraft<CommandRespPayload>;
export type SendReply = (d: Reply) => string;

interface Unacked {
  readonly ctrl: DeviceId;
  readonly draft: Reply;
  readonly firstSentAt: SimTime;
  msgId: string;
  sentAt: SimTime;
  resend: boolean;
}

type NduPhase = 'reboot-secondary' | 'await-hosts' | 'failover' | 'reboot-primary';
interface Ndu {
  phase: NduPhase;
  /** Rebooted first; ends as primary (no failback). */
  readonly first: DeviceId;
  readonly second: DeviceId;
  readonly causes: readonly string[];
  hostsBefore: readonly EndpointId[];
  onlineAt: SimTime | null;
  promotedAt: SimTime | null;
  waitWarned: boolean;
}

export interface SnapshotRequest {
  readonly vm: DeviceId;
  readonly at: SimTime;
  readonly causes: readonly string[];
}

export class FaModelError extends Error {
  override readonly name = 'FaModelError';
}

export class FlashArrayModel {
  readonly controllers: readonly ControllerState[];
  readonly enabled = new Map<EndpointId, boolean>();
  /** vDisk → CVM holding its NVMe Persistent Reservation (Bible 8c). */
  readonly reservations = new Map<string, DeviceId>();
  readonly snapshotRequests: SnapshotRequest[] = [];
  /** CVM → last tick its mgmt API call reached the VIP. */
  readonly mgmtSeen = new Map<DeviceId, SimTime>();
  /** NIC the floating VIP is attached to now. */
  vipNic: string | null;
  now: SimTime = 0;
  coldBoot = false;
  configWarned = false;

  private claimRenewedAt: SimTime = 0;
  private promotion: Promotion | null = null;
  private pauseStartedAt: SimTime | null = null;
  private held: Held[] = [];
  private unacked: Unacked[] = [];
  private ndu: Ndu | null = null;
  private readonly stallCauses = new Map<DeviceId, readonly string[]>();

  constructor(
    readonly facts: FaFacts,
    readonly profile: Profile,
  ) {
    this.controllers = facts.controllers.map((c) => ({
      id: c.id,
      label: c.label,
      slot: c.slot,
      mgmtNic: c.mgmtNic,
      interfaces: c.interfaces,
      role: c.initialRole,
      state: 'up',
      stalledAt: null,
      rebootUntil: null,
      hosts: new Map(),
    }));
    for (const i of facts.interfaces) this.enabled.set(i.id, true);
    this.vipNic = facts.interfaces.find((i) => i.id === facts.vip)?.nic ?? null;
  }

  private get fa(): Profile['flasharray'] {
    return this.profile.flasharray;
  }

  /** Promotion after an unplanned giveback/claim loss: the crash pause minus detection, ≤ promotionMax. */
  get promotionS(): number {
    const f = this.fa;
    const total = Math.min(
      f.primaryCrashPauseS.value,
      f.claimExpiryDetectS.value + f.promotionMaxS.value,
    );
    return Math.max(1, total - f.claimExpiryDetectS.value);
  }

  observe(now: SimTime): void {
    if (now > this.now) this.now = now;
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  controller(id: DeviceId): ControllerState | undefined {
    return this.controllers.find((c) => c.id === id);
  }

  requireController(id: DeviceId): ControllerState {
    const c = this.controller(id);
    if (!c) throw new FaModelError(`unknown controller ${id}`);
    return c;
  }

  primary(): ControllerState | undefined {
    return this.controllers.find((c) => c.role === 'primary');
  }

  /** A primary exists and is completing IO (not stalled, not mid-promotion). */
  serving(): boolean {
    return this.primary()?.state === 'up' && this.promotion === null;
  }

  pauseS(): number {
    return this.pauseStartedAt === null ? 0 : this.now - this.pauseStartedAt + 1;
  }

  nduPhase(): string | null {
    return this.ndu?.phase ?? null;
  }

  heldCount(): number {
    return this.held.length;
  }

  mgmtApi(): 'up' | 'unreachable' {
    for (const t of this.mgmtSeen.values()) if (t >= this.now - 1) return 'up';
    return 'unreachable';
  }

  controllerOf(iface: EndpointId): ControllerState | undefined {
    const f = this.facts.interfaces.find((i) => i.id === iface);
    return f?.controller ? this.controller(f.controller) : undefined;
  }

  /** Endpoint admin state: enabled, and its controller is not rebooting. */
  endpointShouldBeUp(iface: EndpointId): boolean {
    const c = this.controllerOf(iface);
    return (this.enabled.get(iface) ?? true) && c?.state !== 'rebooting';
  }

  // ── Transitions ────────────────────────────────────────────────────────────

  private ev(
    env: FaEnv,
    deviceId: DeviceId,
    code: string,
    text: string,
    causeIds: readonly string[],
    cite: readonly string[],
    confidence: Confidence,
    severity: EventDraft['severity'] = 'warn',
  ): string {
    return env.emit({ severity, deviceId, code, text, causeIds, cite, confidence });
  }

  private applyEndpoints(c: ControllerState, env: FaEnv, causes: readonly string[]): void {
    for (const i of c.interfaces) env.setEndpointUp(i, this.endpointShouldBeUp(i), causes);
  }

  /** Controller crashed (fail action on it or the array). */
  crash(id: DeviceId): void {
    const c = this.requireController(id);
    c.state = 'crashed';
    c.role = 'offline';
    c.stalledAt = null;
    c.rebootUntil = null;
    if (this.promotion?.ctrl === id) this.promotion = null;
    this.held = this.held.filter((h) => h.ctrl !== id);
    this.unacked = this.unacked.filter((u) => u.ctrl !== id);
  }

  /** Controller back from a crash: it rejoins as secondary (promotion, if needed, is separate). */
  recover(id: DeviceId, env: FaEnv): void {
    const c = this.requireController(id);
    c.state = 'up';
    c.role = 'secondary';
    c.rebootUntil = null;
    this.applyEndpoints(c, env, []);
  }

  stall(id: DeviceId, env: FaEnv, causes: readonly string[]): void {
    const c = this.requireController(id);
    if (c.role !== 'primary' || c.state !== 'up') {
      throw new FaModelError(`${id} is not an up primary controller`);
    }
    c.state = 'stalled';
    c.stalledAt = env.now;
    this.stallCauses.set(id, causes);
  }

  setInterfaceEnabled(id: EndpointId, on: boolean, env: FaEnv, causes: readonly string[]): void {
    if (!this.enabled.has(id)) throw new FaModelError(`unknown FA interface ${id}`);
    this.enabled.set(id, on);
    env.setEndpointUp(id, this.endpointShouldBeUp(id), causes);
  }

  private startPromotion(
    to: ControllerState,
    seconds: number,
    env: FaEnv,
    causes: readonly string[],
    cite: readonly string[],
    confidence: Confidence,
  ): void {
    to.role = 'promoting';
    this.promotion = { ctrl: to.id, until: env.now + Math.max(1, seconds), causes };
    this.ev(
      env,
      to.id,
      'fa.promotion.start',
      `${to.label} promoting to primary (≤${Math.max(1, seconds)}s)`,
      causes,
      cite,
      confidence,
    );
  }

  private giveback(
    from: ControllerState,
    env: FaEnv,
    causes: readonly string[],
    why: string,
  ): string {
    from.role = 'secondary';
    from.state = 'up';
    from.stalledAt = null;
    return this.ev(
      env,
      from.id,
      'fa.giveback',
      `${from.label} gives up the primary role (${why})`,
      causes,
      [...this.fa.ioDelayTimeoutS.cite, ...this.fa.plannedFailoverPauseS.cite],
      'verified',
    );
  }

  private peerOf(c: ControllerState): ControllerState | undefined {
    return this.controllers.find((x) => x.id !== c.id && x.state === 'up');
  }

  /** `fa.controller.failover`: planned giveback + promotion with a `plannedFailoverPauseS` pause. */
  plannedFailover(env: FaEnv, causes: readonly string[]): void {
    if (this.ndu) throw new FaModelError('an NDU is in progress');
    const p = this.primary();
    if (p?.state !== 'up' || this.promotion) throw new FaModelError('no serving primary');
    const peer = this.peerOf(p);
    if (!peer) throw new FaModelError('no up secondary to take over');
    this.failoverTo(p, peer, env, causes);
  }

  private failoverTo(
    from: ControllerState,
    to: ControllerState,
    env: FaEnv,
    causes: readonly string[],
  ): void {
    const gb = this.giveback(from, env, causes, 'planned failover');
    const f = this.fa.plannedFailoverPauseS;
    this.startPromotion(to, f.value, env, [gb], f.cite, f.confidence);
  }

  /** `fa.ndu`: secondary reboot → failover → old-primary reboot. */
  startNdu(env: FaEnv, causes: readonly string[]): void {
    if (this.ndu) throw new FaModelError('an NDU is already in progress');
    const p = this.primary();
    if (!p || !this.serving()) throw new FaModelError('the array has no serving primary');
    const s = this.peerOf(p);
    if (s?.role !== 'secondary') throw new FaModelError('both controllers must be up');
    const start = this.ev(
      env,
      this.facts.array.id,
      'fa.ndu.start',
      'Purity NDU started: secondary first, then failover, then the old primary',
      causes,
      ['everpure-upgrade', 'everpure-ha-planned'] satisfies KnownCitationId[],
      'verified',
      'info',
    );
    this.ndu = {
      phase: 'reboot-secondary',
      first: s.id,
      second: p.id,
      causes: [start],
      hostsBefore: [],
      onlineAt: null,
      promotedAt: null,
      waitWarned: false,
    };
    this.reboot(s, env, [start]);
  }

  /** Graceful reboot: ports disappear (no NPIV for Ethernet/NVMe; Everpure NPIV KB). */
  private reboot(c: ControllerState, env: FaEnv, causes: readonly string[]): void {
    const r = this.fa.controllerRebootS;
    if (this.ndu && this.ndu.first === c.id) {
      // Hosts with an association now are the ones the upgrade waits for after the reboot.
      const recent = env.now - this.profile.externalStorage.keepAliveTimeoutS.value;
      this.ndu.hostsBefore = [...c.hosts.entries()]
        .filter(([, t]) => t >= recent)
        .map(([h]) => h)
        .sort();
    }
    c.state = 'rebooting';
    c.role = 'offline';
    c.rebootUntil = env.now + Math.max(1, r.value);
    c.hosts.clear();
    this.held = this.held.filter((h) => h.ctrl !== c.id);
    this.unacked = this.unacked.filter((u) => u.ctrl !== c.id);
    const ev = this.ev(
      env,
      c.id,
      'fa.controller.rebooting',
      `${c.label} rebooting (~${r.value}s); its ports are gone meanwhile`,
      causes,
      [...r.cite, 'everpure-npiv'],
      r.confidence,
      'info',
    );
    this.applyEndpoints(c, env, [ev]);
  }

  /** Per-tick HA work, from the `fa-array` device's preTick (after `observe`). */
  step(env: FaEnv, isUp: (id: DeviceId) => boolean, causeOf: (id: string) => string[]): void {
    const now = env.now;
    const f = this.fa;

    if (this.coldBoot) {
      this.coldBoot = false;
      if (!this.primary() && !this.promotion) {
        const first = this.controllers.find((c) => c.state === 'up');
        if (first) {
          first.role = 'primary';
          this.claimRenewedAt = now;
          this.moveVip(first, env, []);
          this.ev(
            env,
            first.id,
            'fa.array.online',
            `Array online; ${first.label} is primary`,
            causeOf(this.facts.array.id),
            f.claimExpiryDetectS.cite,
            'assumption',
            'info',
          );
        }
      }
    }

    // Drive-quorum claim: the primary renews while alive (a stalled primary still holds it).
    const p = this.primary();
    if (p && isUp(p.id)) this.claimRenewedAt = now;
    else if (!p && !this.promotion && now - this.claimRenewedAt > f.claimExpiryDetectS.value) {
      const cand = this.controllers.find((c) => c.state === 'up' && c.role === 'secondary');
      if (cand) {
        const dead = this.controllers.find((c) => c.id !== cand.id);
        const exp = this.ev(
          env,
          cand.id,
          'fa.claim.expired',
          `${cand.label} sees the primary's drive-quorum claim expire`,
          causeOf(dead?.id ?? this.facts.array.id),
          f.claimExpiryDetectS.cite,
          f.claimExpiryDetectS.confidence,
        );
        this.startPromotion(cand, this.promotionS, env, [exp], f.promotionMaxS.cite, 'verified');
      }
    }

    if (this.promotion && now >= this.promotion.until) {
      const to = this.controller(this.promotion.ctrl);
      const causes = this.promotion.causes;
      this.promotion = null;
      if (to && to.state === 'up') {
        to.role = 'primary';
        this.claimRenewedAt = now;
        const done = this.ev(
          env,
          to.id,
          'fa.promotion.complete',
          `${to.label} is primary; array IO resumes`,
          causes,
          [...f.promotionMaxS.cite, ...f.primaryCrashPauseS.cite],
          'verified',
          'info',
        );
        this.moveVip(to, env, [done]);
      }
    }

    for (const c of this.controllers) {
      if (c.state === 'rebooting' && c.rebootUntil !== null && now >= c.rebootUntil) {
        c.state = 'up';
        c.role = 'secondary';
        c.rebootUntil = null;
        if (this.ndu?.first === c.id) this.ndu.onlineAt = now;
        const ev = this.ev(
          env,
          c.id,
          'fa.controller.online',
          `${c.label} back online as secondary`,
          this.ndu?.causes ?? [],
          f.controllerRebootS.cite,
          f.controllerRebootS.confidence,
          'info',
        );
        this.applyEndpoints(c, env, [ev]);
      }
    }

    // IO delay timeout: a command outstanding on a stalled primary for ioDelayTimeoutS.
    const sp = this.primary();
    if (sp?.state === 'stalled') {
      const oldest = this.held[0];
      if (oldest && now - oldest.receivedAt >= f.ioDelayTimeoutS.value) {
        const to = this.peerOf(sp);
        const t = this.ev(
          env,
          sp.id,
          'fa.io-delay.timeout',
          `${sp.label}: IO outstanding ${f.ioDelayTimeoutS.value}s`,
          this.stallCauses.get(sp.id) ?? [],
          f.ioDelayTimeoutS.cite,
          f.ioDelayTimeoutS.confidence,
        );
        if (to) {
          const gb = this.giveback(sp, env, [t], 'IO delay timeout');
          this.startPromotion(to, this.promotionS, env, [gb], f.promotionMaxS.cite, 'verified');
        }
      }
    }

    this.stepNdu(env);

    if (!this.serving()) this.pauseStartedAt ??= now;
    else this.pauseStartedAt = null;
  }

  private stepNdu(env: FaEnv): void {
    const n = this.ndu;
    if (!n) return;
    const first = this.requireController(n.first);
    const second = this.requireController(n.second);
    const es = this.profile.externalStorage;
    if (n.phase === 'reboot-secondary' && first.state === 'up') n.phase = 'await-hosts';
    if (n.phase === 'await-hosts') {
      // The upgrade waits for hosts to reconnect to the upgraded controller before failing over
      // (`inferred` from the upgrade's host-connectivity checks).
      const since = n.onlineAt ?? env.now;
      const missing = n.hostsBefore.filter((h) => (first.hosts.get(h) ?? -1) < since);
      if (missing.length === 0 && second.state === 'up' && second.role === 'primary') {
        n.phase = 'failover';
        this.failoverTo(second, first, env, n.causes);
      } else if (
        !n.waitWarned &&
        env.now - since > es.reconnectDelayS.value + es.keepAliveTimeoutS.value
      ) {
        n.waitWarned = true;
        this.ev(
          env,
          this.facts.array.id,
          'fa.ndu.waiting-for-hosts',
          `NDU paused: ${missing.length} host path(s) not reconnected to ${first.label}`,
          n.causes,
          ['everpure-upgrade'] satisfies KnownCitationId[],
          'inferred',
        );
      }
    }
    if (n.phase === 'failover' && first.role === 'primary') {
      // Reboot the old primary only after IO held during the failover pause has been released
      // (one tick later), so the pause is not compounded by a second path loss.
      n.promotedAt ??= env.now;
      if (env.now > n.promotedAt) {
        n.phase = 'reboot-primary';
        this.reboot(second, env, n.causes);
      }
    }
    if (n.phase === 'reboot-primary' && second.state === 'up') {
      this.ndu = null;
      this.ev(
        env,
        this.facts.array.id,
        'fa.ndu.complete',
        `Purity NDU complete; ${first.label} stays primary (no failback)`,
        n.causes,
        ['everpure-upgrade'] satisfies KnownCitationId[],
        'inferred',
        'info',
      );
    }
  }

  private moveVip(to: ControllerState, env: FaEnv, causes: readonly string[]): void {
    const vip = this.facts.vip;
    if (vip === null || to.mgmtNic === null || this.vipNic === to.mgmtNic) return;
    this.vipNic = to.mgmtNic;
    env.moveEndpoint(vip, to.mgmtNic, causes);
  }

  // ── NVMe/TCP target ────────────────────────────────────────────────────────

  noteHost(ctrl: DeviceId, host: EndpointId, now: SimTime): void {
    this.controller(ctrl)?.hosts.set(host, now);
  }

  /**
   * A command reached controller `ctrl`. Served at once while the array serves and that
   * controller is up; otherwise held until both are true (array pause, stalled controller).
   */
  receive(
    ctrl: DeviceId,
    msg: Message<CommandPayload>,
    reqLatencyMs: number,
    send: SendReply,
  ): void {
    const c = this.controller(ctrl);
    if (!c) return;
    if (this.held.some((h) => h.msg.payload.key === msg.payload.key)) return;
    if (c.state === 'up' && this.serving()) {
      this.respond(c, msg, 0, reqLatencyMs, send);
    } else {
      this.held.push({ ctrl, msg, receivedAt: this.now, reqLatencyMs });
    }
  }

  /** Release held commands once the array serves again (from the `fa-array` emit). */
  flush(send: SendReply): void {
    if (!this.serving() || this.held.length === 0) return;
    const keep: Held[] = [];
    for (const h of this.held) {
      const c = this.controller(h.ctrl);
      if (c?.state === 'up') this.respond(c, h.msg, this.now - h.receivedAt, h.reqLatencyMs, send);
      else if (c?.state === 'stalled') keep.push(h);
    }
    this.held = keep;
  }

  private execute(cmd: CommandPayload): CommandStatus {
    if (cmd.type === 'resv') {
      // Acquire with preempt: the new owner fences the old one (Bible 8c).
      if (cmd.action === 'acquire') this.reservations.set(cmd.vdisk, cmd.host);
      else if (this.reservations.get(cmd.vdisk) === cmd.host) this.reservations.delete(cmd.vdisk);
      return 'ok';
    }
    // With no reservation held, any host may access the namespace (NVMe Reservations).
    const holder = this.reservations.get(cmd.vdisk);
    return holder === undefined || holder === cmd.host ? 'ok' : 'reservation-conflict';
  }

  private respond(
    c: ControllerState,
    msg: Message<CommandPayload>,
    heldS: number,
    reqLatencyMs: number,
    send: SendReply,
  ): void {
    const cmd = msg.payload;
    const status = this.execute(cmd);
    const read = cmd.type === 'io' && cmd.op === 'read';
    const draft: Reply = {
      kind: cmd.type === 'io' ? NVME_MSG.ioResp : NVME_MSG.resvResp,
      src: msg.dst,
      dst: msg.src,
      // Read data rides the completion.
      size: read && status === 'ok' ? cmd.size : 'small',
      srcPort: msg.flow.dstPort,
      dstPort: msg.flow.srcPort,
      payload: {
        key: cmd.key,
        status,
        latencyMs: reqLatencyMs + (cmd.type === 'io' ? FA_SERVICE_MS[cmd.op] : FA_SERVICE_MS.write),
        heldS,
      },
      ...(msg.causeId === undefined ? {} : { causeId: msg.causeId }),
    };
    const msgId = send(draft);
    this.unacked.push({
      ctrl: c.id,
      draft,
      firstSentAt: this.now,
      msgId,
      sentAt: this.now,
      resend: false,
    });
  }

  /**
   * Target-side TCP: completions the network dropped silently are retransmitted while the
   * association lives (the target tears it down after KATO without traffic).
   */
  inspectResponses(
    fate: (msgId: string, sentAt: SimTime) => 'delivered' | 'dropped' | 'pending',
  ): void {
    const kato = this.profile.externalStorage.keepAliveTimeoutS.value;
    const keep: Unacked[] = [];
    for (const u of this.unacked) {
      const c = this.controller(u.ctrl);
      if (!c || (c.state !== 'up' && c.state !== 'stalled')) continue;
      const f = fate(u.msgId, u.sentAt);
      if (f === 'delivered') continue;
      if (f === 'dropped') {
        if (this.now - u.firstSentAt >= kato) continue;
        u.resend = true;
      }
      keep.push(u);
    }
    this.unacked = keep;
  }

  retransmit(send: SendReply): void {
    for (const u of this.unacked) {
      if (!u.resend) continue;
      u.msgId = send(u.draft);
      u.sentAt = this.now;
      u.resend = false;
    }
  }
}
