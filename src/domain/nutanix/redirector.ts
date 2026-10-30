/**
 * AHV iSCSI redirector and the VM's iSCSI initiator (Bible 5b; AHV Admin Guide 11.2 "Storage
 * Overview"; SPEC §6.2 "iSCSI redirector"). The VM's initiator logs in to the redirector on its
 * host, which only answers logins: it sends each vDisk session to a Stargate that answers, the
 * preferred (local) one first. Compute-only hosts have no local Stargate: their preferred one is
 * assigned round-robin (`assumption`, SPEC §14 #5).
 *
 * - **Portal probes.** The redirector checks a portal answers before sending a login to it. The
 *   model probes every candidate each second (`PROBE_S`), so a login sees current reachability.
 * - **Detection is the initiator's.** A reset connection (Stargate stopped, its process exited on
 *   a live CVM, the CVM rebooting) is noticed at once and the session logs in again. A silent
 *   Stargate (power loss, hang) is noticed only by the initiator's NOPs: `missesToUnhealthy`
 *   unanswered NOPs `nopIntervalS` apart.
 * - **vDisk leadership.** A peer Stargate that receives a redirected login sends the session on to
 *   the vDisk's leader (the owner CVM) while that leader is alive in Zookeeper: to the leader's
 *   external portal. If the leader is alive and its external portal answers (only the host-internal
 *   link to it failed), the same Stargate serves the session over the external network at once,
 *   with no vDisk re-hosting. If the leader is dead or hung, that connection hangs: the session
 *   parks (logged in, not served) and the initiator tries again at its next NOP cycle. Once the
 *   leader has released the vDisk (`Registry.leadershipFree`: at once after an orderly stop or a
 *   process exit, otherwise when that Stargate's Zookeeper session expires) the peer serves it.
 * - **External path.** A session sent on to the local CVM's external portal stays there after the
 *   host-internal link returns, for `externalPathValidityS`, then moves back to the internal path.
 * - **Failback** is driven from the Stargate side: once the preferred Stargate has answered for
 *   `failbackStableS`, sessions return to it one vDisk per `failbackStepS`, each with a brief
 *   pause. A restart starts the stable period again.
 * - **Initiator timeout.** `unservedS` is how long a session has had no Stargate serving it; the
 *   VM crashes past `initiatorSessionTimeoutS` (see `Vm`).
 */

import { asEngineContext } from '../../engine/context';
import type { Ctx, IoRequest } from '../contracts';
import type { IoTarget } from '../workload/vm';
import type { HostFacts } from './facts';
import { type IoReqPayload, MSG, type PingPayload, PORT, portFor } from './messages';
import type { Registry } from './registry';

/** Portal probe cadence (model plumbing: the redirector checks a portal before each login). */
const PROBE_S = 1;
/** Health-key suffix for the local CVM's external portal. */
const EXT = '#ext';

interface PortalHealth {
  /** First tick of the current run of answered probes; null after a miss. */
  upSince: number | null;
  /** Last tick a probe was answered (null: never). */
  lastAnswerAt: number | null;
  sentAt: number | null;
  answered: boolean;
}

interface Session {
  target: string | null;
  /** IO may flow from this tick (re-login pause); Infinity while parked. */
  readyAt: number;
  /** Bumped on every (re-)login: outstanding IO is re-issued on the new session. */
  epoch: number;
  loggedInAt: number;
  /** Next initiator NOP check, and unanswered NOPs in a row. */
  nopAt: number;
  misses: number;
  /** Logged in to a peer that may not serve the vDisk yet (leadership not released). */
  parked: boolean;
  /** Logged in to its local CVM over the external network instead of the host-internal link. */
  external: boolean;
  /** When the session moved to the external path. */
  externalSince: number;
  /** Last tick a Stargate was serving this session. */
  servedAt: number;
}

export class Redirector {
  private readonly health = new Map<string, PortalHealth>();
  private readonly sessions = new Map<string, Session>();
  private lastProbeAt = Number.NEGATIVE_INFINITY;
  private probeAll = false;
  private lastFailbackAt = Number.NEGATIVE_INFINITY;
  private epochs = 0;
  private readonly cvmOrder: readonly string[];
  /** Outages already reported (`redirector.unhealthy` / `redirector.parked`), by Stargate. */
  private readonly reported = new Map<string, string>();

  constructor(
    private readonly host: HostFacts,
    private readonly reg: Registry,
  ) {
    this.cvmOrder = reg.facts.cvms.map((c) => c.id);
  }

  /** Summary for the host inspector: vDisk → current Stargate (or `none`). */
  sessionsView(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [v, s] of [...this.sessions].sort(([a], [b]) => (a < b ? -1 : 1))) {
      out[v] =
        s.target === null
          ? 'none'
          : s.parked
            ? `${s.target} (parked)`
            : s.external
              ? `${s.target} (external)`
              : s.target;
    }
    return out;
  }

  /** Stargates this host's probes find not answering. */
  unhealthyView(): string[] {
    return [...this.health]
      .filter(([k, h]) => !k.endsWith(EXT) && h.sentAt !== null && h.upSince === null)
      .map(([c]) => c)
      .sort();
  }

  // ── Used by VMs (via the registry's VmEnv) ──────────────────────────────

  target(vdisk: string): IoTarget {
    const s = this.session(vdisk);
    if (s.target === null) return { status: 'no-path' };
    if (this.reg.now < s.readyAt) return { status: 'held' };
    return { status: 'ready', cvm: s.target, session: s.epoch };
  }

  /** Seconds the session for `vdisk` has had no Stargate serving it. */
  unservedS(vdisk: string, now: number): number {
    const s = this.sessions.get(vdisk);
    return s === undefined ? 0 : Math.max(0, now - s.servedAt);
  }

  sendIo(io: IoRequest, ctx: Ctx): string | null {
    const s = this.session(io.vdisk);
    if (s.target === null) return null;
    const ends = this.endpoints(s.target, s.external);
    if (ends === null) return null;
    const ectx = asEngineContext(ctx);
    const payload: IoReqPayload = { t: 'req', io, host: this.host.id };
    return ctx.send({
      kind: io.op === 'read' ? MSG.ioRead : MSG.ioWrite,
      src: ends.src,
      dst: ends.dst,
      // A read request is a small CDB; a write carries its data.
      size: io.op === 'read' ? 'small' : io.size,
      flow: ectx.flow(ends.src, ends.dst, {
        srcPort: portFor(`${this.host.id}/${io.vdisk}`),
        dstPort: PORT.iscsi,
      }),
      payload,
      causeId: io.id,
    });
  }

  /** Point a vDisk's session at its preferred Stargate (fresh login after an HA restart). */
  loginFresh(vdisk: string): string | null {
    this.sessions.delete(vdisk);
    return this.session(vdisk).target;
  }

  /** The VM migrated away: its sessions on this host end. */
  logout(vdisk: string): void {
    this.sessions.delete(vdisk);
  }

  // ── Hooks (called by the host device while it is alive) ─────────────────

  emit(ctx: Ctx): void {
    if (ctx.now - this.lastProbeAt < PROBE_S) return;
    this.lastProbeAt = ctx.now;
    // Probe keys: a CVM id (its usual path), or `<local CVM>#ext` for its external portal.
    const probe = new Set<string>();
    const local = this.host.cvm;
    if (local !== null) probe.add(local);
    for (const [vdisk, s] of this.sessions) {
      if (s.target !== null) probe.add(this.key(s.target, s.external));
      const pref = this.reg.preferredCvm(this.host.id, vdisk);
      if (pref !== null) probe.add(pref);
    }
    if (this.probeAll) for (const c of this.cvmOrder) probe.add(c);
    // The local CVM's external portal is probed while its internal link does not answer.
    if (local !== null && (this.probeAll || this.healthOf(local).upSince === null)) {
      probe.add(this.key(local, true));
    }
    const ectx = asEngineContext(ctx);
    for (const k of [...probe].sort()) {
      const ext = k.endsWith(EXT);
      const cvm = ext ? k.slice(0, -EXT.length) : k;
      const ends = this.endpoints(cvm, ext);
      const h = this.healthOf(k);
      h.sentAt = ctx.now;
      h.answered = false;
      if (ends === null) continue;
      const payload: PingPayload = { t: 'req', from: this.host.id };
      ctx.send({
        kind: MSG.nop,
        src: ends.src,
        dst: ends.dst,
        size: 'small',
        flow: ectx.flow(ends.src, ends.dst, {
          srcPort: portFor(`${this.host.id}~nop${ext ? EXT : ''}`),
          dstPort: PORT.iscsi,
        }),
        payload,
      });
    }
  }

  /** A NOP reply from `cvm`, received on this host's endpoint `dst` (which path it came over). */
  onNopReply(cvm: string, dst?: string): void {
    const ext = cvm === this.host.cvm && dst !== undefined && dst === this.host.mgmtEndpoint;
    const h = this.health.get(this.key(cvm, ext));
    if (h) h.answered = true;
  }

  tick(ctx: Ctx): void {
    const R = ctx.profile.redirector;
    const now = ctx.now;
    for (const h of this.health.values()) {
      if (h.sentAt !== now) continue;
      if (h.answered) {
        h.upSince ??= now;
        h.lastAnswerAt = now;
      } else h.upSince = null;
    }

    const redirected = new Map<string, number>();
    for (const [vdisk, s] of this.sorted()) {
      if (s.target !== null && !this.dropped(vdisk, s, ctx)) {
        this.noteServed(s, now);
        continue;
      }
      // A parked session may log in to the same peer again; a failed target is avoided.
      const from = s.target;
      const avoid = from !== null && !s.parked ? from : null;
      const next = this.pickLogin(vdisk, avoid);
      this.login(vdisk, s, next, now, ctx, from);
      if (next !== null && next !== this.reg.preferredCvm(this.host.id, vdisk)) {
        redirected.set(next, (redirected.get(next) ?? 0) + 1);
      }
      this.noteServed(s, now);
    }
    this.failback(ctx);
    this.returnInternal(ctx);

    for (const [to, n] of [...redirected].sort(([a], [b]) => (a < b ? -1 : 1))) {
      ctx.emit({
        severity: 'warn',
        deviceId: this.host.id,
        code: 'redirector.redirect',
        text: `${this.host.label}: ${n} iSCSI session(s) logged in to ${to} through the redirector`,
        causeIds: [],
        cite: R.missesToUnhealthy.cite,
        confidence: R.missesToUnhealthy.confidence,
      });
    }
    // Forget reported outages once the Stargate serves again.
    for (const cvm of [...this.reported.keys()]) {
      if (this.reg.stargateOutage(cvm) === null) this.reported.delete(cvm);
    }
    // Probe every portal while a session needs a new target, so a login finds one that answers.
    this.probeAll = [...this.sessions.values()].some(
      (s) =>
        s.target === null ||
        s.parked ||
        s.misses > 0 ||
        this.healthOf(this.key(s.target, s.external)).upSince === null ||
        this.reg.stargateOutage(s.target) !== null,
    );
    if (this.host.cvm !== null && this.healthOf(this.host.cvm).upSince === null) {
      this.probeAll = true;
    }
  }

  /** Host went down: sessions and health are rebuilt on boot. */
  reset(): void {
    this.health.clear();
    this.sessions.clear();
    this.reported.clear();
    this.lastProbeAt = Number.NEGATIVE_INFINITY;
    this.lastFailbackAt = Number.NEGATIVE_INFINITY;
    this.probeAll = false;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private sorted(): [string, Session][] {
    return [...this.sessions].sort(([a], [b]) => (a < b ? -1 : 1));
  }

  private session(vdisk: string): Session {
    let s = this.sessions.get(vdisk);
    if (!s) {
      const now = this.reg.now;
      const pref = this.reg.preferredCvm(this.host.id, vdisk);
      const target = pref !== null && this.usable(pref) ? pref : this.pickLogin(vdisk, null);
      s = {
        target,
        readyAt: 0,
        epoch: ++this.epochs,
        loggedInAt: now,
        nopAt: now + this.reg.profile.redirector.nopIntervalS.value,
        misses: 0,
        parked: false,
        external: false,
        externalSince: now,
        servedAt: now,
      };
      this.sessions.set(vdisk, s);
    }
    return s;
  }

  /**
   * The session must log in again: its connection was reset, or its initiator's NOPs went
   * unanswered `missesToUnhealthy` times (a parked session's NOPs are never answered).
   */
  private dropped(vdisk: string, s: Session, ctx: Ctx): boolean {
    const R = ctx.profile.redirector;
    const target = s.target;
    if (target === null) return true;
    const o = this.reg.stargateOutage(target);
    if (o !== null && o.resetAt !== null && o.resetAt >= s.loggedInAt) {
      this.report(target, 'reset', ctx, `connection reset by ${target}; logging in again`);
      return true;
    }
    if (ctx.now < s.nopAt) return false;
    s.nopAt = ctx.now + R.nopIntervalS.value;
    const h = this.healthOf(this.key(target, s.external));
    const answered =
      !s.parked && h.lastAnswerAt !== null && h.lastAnswerAt > ctx.now - R.nopIntervalS.value;
    s.misses = answered ? 0 : s.misses + 1;
    if (s.misses < R.missesToUnhealthy.value) return false;
    if (!s.parked) {
      this.report(
        target,
        'unhealthy',
        ctx,
        `the initiator's NOPs to Stargate on ${target} went unanswered ${s.misses} times, ${R.nopIntervalS.value} s apart; logging in again (${vdisk})`,
      );
    }
    return true;
  }

  /** Log the session in to `next`; it parks if `next` may not serve the vDisk yet. */
  private login(
    vdisk: string,
    s: Session,
    next: string | null,
    now: number,
    ctx: Ctx,
    from: string | null,
  ): void {
    const R = ctx.profile.redirector;
    s.target = next;
    s.epoch = ++this.epochs;
    s.loggedInAt = now;
    s.nopAt = now + R.nopIntervalS.value;
    s.misses = 0;
    s.external = false;
    if (next === null) {
      s.parked = false;
      s.readyAt = now;
      return;
    }
    // The peer's iSCSI load balancer sends the session on to the vDisk's leader while it is alive
    // in Zookeeper. A leader that serves and whose external portal answers takes it at once.
    const leader = this.reg.owner.get(vdisk);
    if (
      leader !== undefined &&
      leader !== next &&
      this.reg.isStargateUp(leader) &&
      this.externalUsable(leader)
    ) {
      s.target = leader;
      s.external = leader === this.host.cvm;
      s.externalSince = now;
      s.parked = false;
      s.readyAt = now + R.redirectStallS.value;
      this.report(
        leader,
        'leader',
        ctx,
        `${next} sent ${vdisk}'s session on to its leader ${leader}'s external portal; ${leader} still serves it, over the external network`,
        R.redirectStallS,
      );
      return;
    }
    s.parked = !this.reg.leadershipFree(vdisk, next, now);
    s.readyAt = s.parked ? Number.POSITIVE_INFINITY : now + R.redirectStallS.value;
    const owner = this.reg.owner.get(vdisk) ?? from;
    if (s.parked && owner !== undefined && owner !== null) {
      this.report(
        owner,
        'parked',
        ctx,
        `${next} sends ${owner}'s vDisk sessions on to ${owner}, which does not answer; ${next} may serve them only once ${owner}'s Zookeeper session expires, so the sessions wait and the initiator tries again at its next NOP cycle`,
        ctx.profile.hci.stargateDownDetectS,
      );
    }
  }

  /** A Stargate serves the session this tick (for the initiator timeout). */
  private noteServed(s: Session, now: number): void {
    if (s.target === null || s.parked || now < s.readyAt) return;
    if (!this.reg.isStargateUp(s.target)) return;
    if (this.healthOf(this.key(s.target, s.external)).upSince === null) return;
    s.servedAt = now;
  }

  /**
   * A session on its local CVM's external portal moves back to the host-internal link once that
   * link has answered for `externalPathValidityS` since the session moved (brief re-login pause).
   */
  private returnInternal(ctx: Ctx): void {
    const R = ctx.profile.redirector;
    const V = R.externalPathValidityS.value;
    for (const [vdisk, s] of this.sorted()) {
      if (!s.external || s.target === null || s.parked) continue;
      const h = this.healthOf(s.target);
      if (h.upSince === null || ctx.now - Math.max(h.upSince, s.externalSince) < V) continue;
      s.external = false;
      s.epoch = ++this.epochs;
      s.loggedInAt = ctx.now;
      s.nopAt = ctx.now + R.nopIntervalS.value;
      s.misses = 0;
      s.readyAt = ctx.now + R.redirectStallS.value;
      ctx.emit({
        severity: 'info',
        deviceId: this.host.id,
        code: 'redirector.path-internal',
        text: `${this.host.label}: ${vdisk} moved back from ${s.target}'s external portal to the host-internal link (${V} s validity)`,
        causeIds: [],
        cite: R.externalPathValidityS.cite,
        confidence: R.externalPathValidityS.confidence,
      });
    }
  }

  /** Stargate-driven failback: one vDisk per `failbackStepS` once the preferred one is stable. */
  private failback(ctx: Ctx): void {
    const R = ctx.profile.redirector;
    if (ctx.now - this.lastFailbackAt < R.failbackStepS.value) return;
    for (const [vdisk, s] of this.sorted()) {
      const pref = this.reg.preferredCvm(this.host.id, vdisk);
      if (pref === null || s.target === null || s.target === pref || s.parked) continue;
      if (!this.stable(pref, ctx.now) || !this.usable(pref)) continue;
      // The serving Stargate hands the vDisk back (it releases it first): no park.
      s.target = pref;
      s.epoch = ++this.epochs;
      s.loggedInAt = ctx.now;
      s.nopAt = ctx.now + R.nopIntervalS.value;
      s.misses = 0;
      s.readyAt = ctx.now + R.redirectStallS.value;
      this.lastFailbackAt = ctx.now;
      ctx.emit({
        severity: 'info',
        deviceId: this.host.id,
        code: 'redirector.failback',
        text: `${this.host.label}: ${vdisk} failed back to ${pref} after it was stable ${R.failbackStableS.value} s (one vDisk per ${R.failbackStepS.value} s)`,
        causeIds: [],
        cite: R.failbackStableS.cite,
        confidence: R.failbackStableS.confidence,
      });
      return;
    }
  }

  private report(
    cvm: string,
    kind: 'reset' | 'unhealthy' | 'parked' | 'leader',
    ctx: Ctx,
    text: string,
    cited = ctx.profile.redirector.missesToUnhealthy,
  ): void {
    const key = `${kind}`;
    const seen = this.reported.get(cvm) ?? '';
    if (seen.split(',').includes(key)) return;
    this.reported.set(cvm, seen === '' ? key : `${seen},${key}`);
    if (kind === 'reset') return;
    ctx.emit({
      severity: 'warn',
      deviceId: this.host.id,
      code:
        kind === 'parked'
          ? 'redirector.parked'
          : kind === 'leader'
            ? 'redirector.leader-redirect'
            : 'redirector.unhealthy',
      text: `${this.host.label}: ${text}`,
      causeIds: [],
      cite: cited.cite,
      confidence: cited.confidence,
    });
  }

  /** Health key: the CVM id, or `<local CVM>#ext` for the local CVM's external portal. */
  private key(cvm: string, external: boolean): string {
    return external && cvm === this.host.cvm ? `${cvm}${EXT}` : cvm;
  }

  private healthOf(key: string): PortalHealth {
    let h = this.health.get(key);
    if (!h) {
      // Never probed: assume answering until probes say otherwise.
      h = { upSince: 0, lastAnswerAt: 0, sentAt: null, answered: false };
      this.health.set(key, h);
    }
    return h;
  }

  /** `cvm`'s external portal answers this host's probes (the usual path for a remote CVM). */
  private externalUsable(cvm: string): boolean {
    return (
      this.healthOf(this.key(cvm, true)).upSince !== null && this.endpoints(cvm, true) !== null
    );
  }

  /**
   * A login target: its portal answers probes and it is a live Stargate in Zeus (not down, not on
   * a fenced host). Model shortcut: the Zeus view is read from the registry.
   */
  private usable(cvm: string): boolean {
    return (
      this.healthOf(cvm).upSince !== null &&
      this.reg.isStargateUp(cvm) &&
      this.endpoints(cvm) !== null
    );
  }

  private stable(cvm: string, now: number): boolean {
    const h = this.healthOf(cvm);
    const R = this.reg.profile.redirector;
    return h.upSince !== null && now - h.upSince >= R.failbackStableS.value;
  }

  /**
   * Login target: the preferred Stargate if it is stable (a working session moves back only on
   * failback), else the first usable CVM after the preferred one in ring order (deterministic
   * spread). A session that lost its target may log in to the preferred one as soon as it answers.
   */
  private pickLogin(vdisk: string, from: string | null): string | null {
    const now = this.reg.now;
    const pref = this.reg.preferredCvm(this.host.id, vdisk);
    if (pref !== null && pref !== from && this.usable(pref)) {
      if (from === null || this.stable(pref, now)) return pref;
    }
    const start = pref === null ? 0 : Math.max(0, this.cvmOrder.indexOf(pref));
    const n = this.cvmOrder.length;
    for (let i = 1; i <= n; i++) {
      const c = this.cvmOrder[(start + i) % n];
      if (c === undefined || c === from || c === pref) continue;
      if (this.usable(c)) return c;
    }
    if (pref !== null && pref !== from && this.usable(pref)) return pref;
    return null;
  }

  /**
   * Local Stargate over virbr0; remote ones (and the local one's external portal) from the host
   * mgmt IP to the CVM's mgmt IP.
   */
  private endpoints(cvm: string, external = false): { src: string; dst: string } | null {
    const f = this.reg.facts.cvm(cvm);
    if (!f) return null;
    if (!external && cvm === this.host.cvm && this.host.internalEndpoint !== null) {
      return { src: this.host.internalEndpoint, dst: f.internalEndpoint };
    }
    if (this.host.mgmtEndpoint === null) return null;
    return { src: this.host.mgmtEndpoint, dst: f.mgmtEndpoint };
  }
}
