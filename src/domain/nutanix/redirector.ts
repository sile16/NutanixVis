/**
 * AHV iSCSI redirector (Bible 5b; AHV Admin Guide 11.2 "Storage Overview"). QEMU's iSCSI portal
 * is the redirector on the host; each vDisk session is redirected to a healthy Stargate,
 * preferring the local one.
 *
 * Health: the redirector NOPs the Stargates it uses every `redirector.nopIntervalS`. A Stargate
 * that misses `missesToUnhealthy` NOPs within `missWindowS` is unhealthy and its sessions move to
 * a healthy remote Stargate after a `redirectStallS` re-login stall. Sessions fail back once the
 * preferred Stargate has answered continuously for `failbackStableS` (Nutanix blog "controller
 * failure"; Bible 5b). Compute-only hosts have no local Stargate: their preferred Stargate is
 * assigned round-robin (`assumption`), with the same timers (SPEC §14 #5).
 */

import { asEngineContext } from '../../engine/context';
import type { Ctx, IoRequest } from '../contracts';
import type { IoTarget } from '../workload/vm';
import type { HostFacts } from './facts';
import { type IoReqPayload, MSG, type PingPayload, PORT, portFor } from './messages';
import type { Registry } from './registry';

interface StargateHealth {
  /** Times of missed NOPs inside the window. */
  misses: number[];
  /** First tick of the current run of answered NOPs; null after a miss. */
  upSince: number | null;
  /** Tick the last NOP was sent (null: never probed). */
  sentAt: number | null;
  answered: boolean;
  /** `redirector.unhealthy` already reported for the current outage. */
  reported: boolean;
}

interface Session {
  target: string | null;
  /** IO may flow from this tick (re-login stall after a redirect / failback). */
  readyAt: number;
  /** Bumped on every (re-)login: outstanding IO is re-issued on the new session. */
  epoch: number;
}

export class Redirector {
  private readonly health = new Map<string, StargateHealth>();
  private readonly sessions = new Map<string, Session>();
  private lastNopAt = Number.NEGATIVE_INFINITY;
  private probeAll = false;
  private epochs = 0;
  private readonly cvmOrder: readonly string[];

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
      out[v] = s.target ?? 'none';
    }
    return out;
  }

  unhealthyView(): string[] {
    return [...this.health]
      .filter(([, h]) => this.unhealthy(h))
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

  sendIo(io: IoRequest, ctx: Ctx): string | null {
    const s = this.session(io.vdisk);
    if (s.target === null) return null;
    const ends = this.endpoints(s.target);
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

  // ── Hooks (called by the host device while it is alive) ─────────────────

  emit(ctx: Ctx): void {
    const R = ctx.profile.redirector;
    if (ctx.now - this.lastNopAt < R.nopIntervalS.value) return;
    this.lastNopAt = ctx.now;
    const probe = new Set<string>();
    if (this.host.cvm !== null) probe.add(this.host.cvm);
    for (const [vdisk, s] of this.sessions) {
      if (s.target !== null) probe.add(s.target);
      const pref = this.reg.preferredCvm(this.host.id, vdisk);
      if (pref !== null) probe.add(pref);
    }
    if (this.probeAll) for (const c of this.cvmOrder) probe.add(c);
    const ectx = asEngineContext(ctx);
    for (const cvm of [...probe].sort()) {
      const ends = this.endpoints(cvm);
      const h = this.healthOf(cvm);
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
          srcPort: portFor(`${this.host.id}~nop`),
          dstPort: PORT.iscsi,
        }),
        payload,
      });
    }
  }

  onNopReply(cvm: string): void {
    const h = this.health.get(cvm);
    if (h) h.answered = true;
  }

  tick(ctx: Ctx): void {
    const R = ctx.profile.redirector;
    const now = ctx.now;
    for (const h of this.health.values()) {
      if (h.sentAt !== now) continue;
      if (h.answered) h.upSince ??= now;
      else {
        h.misses.push(now);
        h.upSince = null;
      }
    }
    for (const h of this.health.values()) {
      h.misses = h.misses.filter((t) => t > now - R.missWindowS.value);
      if (!this.unhealthy(h)) h.reported = false;
    }

    const redirected = new Map<string, number>();
    const failedBack: string[] = [];
    for (const [vdisk, s] of [...this.sessions].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const pref = this.reg.preferredCvm(this.host.id, vdisk);
      if (s.target !== null) {
        const h = this.healthOf(s.target);
        // Move away while it is failing; a session logged in fresh after an outage stays on a
        // Stargate that answers again, even with older misses still in the window.
        if (this.unhealthy(h) && h.upSince === null) {
          this.reportUnhealthy(s.target, h, ctx);
          const next = this.pick(vdisk, s.target, now);
          this.relogin(s, next, now + R.redirectStallS.value);
          if (next !== null) redirected.set(next, (redirected.get(next) ?? 0) + 1);
          continue;
        }
        if (pref !== null && s.target !== pref && this.stable(pref, now) && this.usable(pref)) {
          this.relogin(s, pref, now + R.redirectStallS.value);
          failedBack.push(vdisk);
        }
        continue;
      }
      // No target (every Stargate was failing): a fresh login, so any Stargate that answers its
      // NOPs again will do, the preferred one first. The failback hold only guards moving a
      // working session (`inferred`).
      const next = this.pickFresh(vdisk);
      if (next !== null) {
        this.relogin(s, next, now + R.redirectStallS.value);
        if (next !== pref) redirected.set(next, (redirected.get(next) ?? 0) + 1);
      }
    }
    // Local Stargate health is reported even without a session on it (inspector / explain).
    if (this.host.cvm !== null) {
      const h = this.healthOf(this.host.cvm);
      if (this.unhealthy(h)) this.reportUnhealthy(this.host.cvm, h, ctx);
    }

    for (const [to, n] of [...redirected].sort(([a], [b]) => (a < b ? -1 : 1))) {
      ctx.emit({
        severity: 'warn',
        deviceId: this.host.id,
        code: 'redirector.redirect',
        text: `${this.host.label}: ${n} iSCSI session(s) redirected to ${to}`,
        causeIds: [],
        cite: R.missesToUnhealthy.cite,
        confidence: R.missesToUnhealthy.confidence,
      });
    }
    if (failedBack.length > 0) {
      ctx.emit({
        severity: 'info',
        deviceId: this.host.id,
        code: 'redirector.failback',
        text: `${this.host.label}: ${failedBack.length} iSCSI session(s) failed back after ${R.failbackStableS.value} s stable`,
        causeIds: [],
        cite: R.failbackStableS.cite,
        confidence: R.failbackStableS.confidence,
      });
    }

    // Probe every Stargate while any session lacks a healthy target or its target is missing
    // NOPs, so a redirect can pick a Stargate that is known to answer.
    this.probeAll = [...this.sessions.values()].some(
      (s) => s.target === null || (this.health.get(s.target)?.misses.length ?? 0) > 0,
    );
    if (this.host.cvm !== null && (this.health.get(this.host.cvm)?.misses.length ?? 0) > 0) {
      this.probeAll = true;
    }
  }

  /** Host went down: sessions and health are rebuilt on boot. */
  reset(): void {
    this.health.clear();
    this.sessions.clear();
    this.lastNopAt = Number.NEGATIVE_INFINITY;
    this.probeAll = false;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private session(vdisk: string): Session {
    let s = this.sessions.get(vdisk);
    if (!s) {
      const pref = this.reg.preferredCvm(this.host.id, vdisk);
      const ok =
        pref !== null && !this.unhealthy(this.healthOf(pref)) && this.reg.isStargateUp(pref);
      s = {
        target: ok ? pref : this.pick(vdisk, null, this.reg.now),
        readyAt: 0,
        epoch: ++this.epochs,
      };
      this.sessions.set(vdisk, s);
    }
    return s;
  }

  private relogin(s: Session, target: string | null, readyAt: number): void {
    s.target = target;
    s.readyAt = readyAt;
    s.epoch = ++this.epochs;
  }

  private healthOf(cvm: string): StargateHealth {
    let h = this.health.get(cvm);
    if (!h) {
      // Never probed: assume healthy until NOPs say otherwise.
      h = { misses: [], upSince: 0, sentAt: null, answered: false, reported: false };
      this.health.set(cvm, h);
    }
    return h;
  }

  private unhealthy(h: StargateHealth): boolean {
    return h.misses.length >= this.reg.profile.redirector.missesToUnhealthy.value;
  }

  private healthy(cvm: string): boolean {
    const h = this.healthOf(cvm);
    return h.upSince !== null && !this.unhealthy(h);
  }

  /**
   * A login target: answering our NOPs, and listed as a live Stargate in Zeus (not down, not on
   * a fenced host). Model shortcut: the Zeus view is read from the registry.
   */
  private usable(cvm: string): boolean {
    return this.healthy(cvm) && this.reg.isStargateUp(cvm) && this.endpoints(cvm) !== null;
  }

  private stable(cvm: string, now: number): boolean {
    const h = this.healthOf(cvm);
    const R = this.reg.profile.redirector;
    return this.healthy(cvm) && h.upSince !== null && now - h.upSince >= R.failbackStableS.value;
  }

  /**
   * Next Stargate for a session: the preferred one if it is stable, else the first healthy CVM
   * after the preferred one in ring order (deterministic spread).
   */
  private pick(vdisk: string, avoid: string | null, now: number): string | null {
    const pref = this.reg.preferredCvm(this.host.id, vdisk);
    if (pref !== null && pref !== avoid && this.stable(pref, now) && this.usable(pref)) return pref;
    const start = pref === null ? 0 : Math.max(0, this.cvmOrder.indexOf(pref));
    const n = this.cvmOrder.length;
    for (let i = 1; i <= n; i++) {
      const c = this.cvmOrder[(start + i) % n];
      if (c === undefined || c === avoid || c === pref) continue;
      if (this.usable(c)) return c;
    }
    return null;
  }

  /** Login target for a session without one: a live Stargate that answered its latest NOP. */
  private pickFresh(vdisk: string): string | null {
    const answering = (c: string) =>
      this.healthOf(c).upSince !== null && this.reg.isStargateUp(c) && this.endpoints(c) !== null;
    const pref = this.reg.preferredCvm(this.host.id, vdisk);
    if (pref !== null && answering(pref)) return pref;
    const start = pref === null ? 0 : Math.max(0, this.cvmOrder.indexOf(pref));
    const n = this.cvmOrder.length;
    for (let i = 1; i <= n; i++) {
      const c = this.cvmOrder[(start + i) % n];
      if (c !== undefined && c !== pref && answering(c)) return c;
    }
    return null;
  }

  private reportUnhealthy(cvm: string, h: StargateHealth, ctx: Ctx): void {
    if (h.reported) return;
    h.reported = true;
    const R = ctx.profile.redirector;
    ctx.emit({
      severity: 'warn',
      deviceId: this.host.id,
      code: 'redirector.unhealthy',
      text: `${this.host.label}: Stargate on ${cvm} missed ${R.missesToUnhealthy.value} NOPs within ${R.missWindowS.value} s`,
      causeIds: [],
      cite: R.missesToUnhealthy.cite,
      confidence: R.missesToUnhealthy.confidence,
    });
  }

  /** Local Stargate over virbr0; remote ones from the host mgmt IP to the CVM's mgmt IP. */
  private endpoints(cvm: string): { src: string; dst: string } | null {
    const f = this.reg.facts.cvm(cvm);
    if (!f) return null;
    if (cvm === this.host.cvm && this.host.internalEndpoint !== null) {
      return { src: this.host.internalEndpoint, dst: f.internalEndpoint };
    }
    if (this.host.mgmtEndpoint === null) return null;
    return { src: this.host.mgmtEndpoint, dst: f.mgmtEndpoint };
  }
}
