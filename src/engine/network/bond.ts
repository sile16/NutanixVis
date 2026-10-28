/**
 * Bond (AHV OVS virtual switch uplink group) runtime (SPEC §5.3 table and "Failure detection in
 * bonds"; §6.4b layer 5).
 *
 * Member selection by flow:
 * - `active-backup`: every flow uses the single active member; no failback on recovery. The
 *   active member is "simply the first member to be enabled" (OVS bonding docs), or the one set
 *   with `ovs-appctl bond/set-active-slave` (`initialActive`; Everpure "Configure Nutanix
 *   Cluster for FlashArray"), whenever the bond has to choose one.
 * - `balance-slb`: hash of (srcMac, VLAN) into 256 buckets, each bucket pinned to one member.
 * - `balance-tcp`: hash of the L4 tuple into 256 buckets. Needs LACP; across two switches the
 *   partners must share an MLAG domain, otherwise only one partner's members aggregate.
 * - `no-bond`: only the first uplink is used.
 * In both hashed modes an unassigned bucket (or one whose member died) is assigned to the next
 * usable member round-robin, and buckets are periodically rebalanced by load.
 *
 * VLAN awareness (`slbVlanAware`, default on; owner decision for isolated storage VLANs):
 * `balance-slb` pinning, rebalancing and failover, and the `active-backup` choice of member for
 * a VLAN, only use members whose link and partner switch carry that VLAN. With it off the bond
 * behaves like plain OVS and may pin a VLAN onto a member that blackholes it.
 *
 * Failure detection: carrier loss removes a member immediately in every mode (OVS
 * `bond_downdelay` default 0, "disable the interface immediately"; ovs-vswitchd.conf.db(5)).
 * A hung member (carrier up, frames dropped) is only detected by LACP, after the fast/slow
 * detection time, and only because its LACPDUs stop: OVS judges LACP liveness by LACPDU receipt
 * alone (OVS `lib/lacp.c`). The other modes watch carrier only (`bond-detect-mode` carrier or
 * miimon), so a hung member blackholes its traffic until repaired. The only recovery is carrier
 * loss (switch power-off or port admin-down), followed by an immediate failover.
 *
 * `lacp-fallback-ab` (balance-tcp; Prism Active-Active always sets it, AHV Admin Guide 11.2):
 * a member whose LACP timed out is detached while another member is still negotiated, so the
 * bond carries on with the survivors. Only when no member is negotiated does the bond fall back
 * to active-backup over every member with carrier (OVS `lacp_update_attached`). The 3 s that OVS
 * spends between EXPIRED and DEFAULTED is folded into the detection time (`inferred`: a hung
 * member drops frames either way).
 */
import type { TimerQueue } from '../clock';
import { fnv1a } from '../hash';
import type { DeviceStatus, EventDraft, FlowId, SimTime, TimerHandle, ViewField } from '../types';
import {
  type BondMode,
  type BondSpec,
  type LacpRate,
  type NetworkConfig,
  NetworkError,
} from './spec';

export const BOND_BUCKETS = 256;

/** What the bond can observe about one member (plus the hidden `hung` truth). */
export interface MemberProbe {
  /** NIC, cable and partner port all up. */
  readonly carrier: boolean;
  /** Carrier is up but frames are dropped (NIC, link or partner switch hung). */
  readonly hung: boolean;
  /** LACP partner identity: shared by MLAG peers. `null` when not cabled. */
  readonly partnerKey: string | null;
  /** Events from this reconcile pass that explain a change on this member (link up/down). */
  readonly causeIds: readonly string[];
}

export interface BondEnv {
  now(): SimTime;
  readonly timers: TimerQueue;
  config(): NetworkConfig;
  probe(nic: string): MemberProbe;
  /** Whether the member's link and partner switch carry `vlan` (configuration, not state). */
  carries(nic: string, vlan: number): boolean;
  emit(draft: Omit<EventDraft, 'causeIds' | 'cite'> & { causeIds?: readonly string[] }): string;
  causes(): readonly string[];
  withCauses(causes: readonly string[], fn: () => void): void;
  /** Re-run network reconciliation (after an LACP detection timer fires). */
  reconcile(): void;
}

/** A member as the bond sees it. Hidden hangs show as `up`/`active` until LACP detects them. */
export type MemberState =
  | 'active'
  | 'backup'
  | 'up'
  | 'down'
  | 'lacp-down'
  | 'detached'
  | 'unused'
  | 'not-uplink';

export class BondRuntime {
  readonly id: string;
  readonly owner: string | undefined;
  readonly label: string;
  readonly group: string | undefined;
  private modeValue: BondMode;
  private uplinksValue: string[];
  private readonly cabledValue: readonly string[];
  private rate: LacpRate;
  private vlanAwareValue: boolean;
  private readonly initialActiveValue: string | undefined;
  /** balance-tcp with no negotiated member: running active-backup (`lacp-fallback-ab`). */
  private fallbackValue = false;

  private active: string | null = null;
  private eligibleList: string[] = [];
  private detachedSet = new Set<string>();
  private readonly lacpDown = new Set<string>();
  private readonly lacpTimers = new Map<string, TimerHandle>();
  private readonly lacpStart = new Map<string, { causes: readonly string[]; seconds: number }>();
  private misconfigValue: string | null = null;
  private buckets: (string | null)[] = new Array<string | null>(BOND_BUCKETS).fill(null);
  private bucketLoad: number[] = new Array<number>(BOND_BUCKETS).fill(0);
  private bucketVlans = new Map<number, Set<number>>();
  /** Buckets pinned by `forcePin` (vswitch.rebalance): plain-OVS pins that ignore VLAN awareness. */
  private forced = new Map<number, string>();
  private rr = 0;
  private lastRebalance: SimTime;
  private initialized = false;

  constructor(
    spec: BondSpec,
    private readonly env: BondEnv,
  ) {
    this.id = spec.id;
    this.owner = spec.owner;
    this.label = spec.label ?? spec.id;
    this.group = spec.group;
    this.modeValue = spec.mode;
    this.uplinksValue = [...spec.uplinks];
    this.cabledValue = [...(spec.members ?? spec.uplinks)];
    this.rate = spec.lacpRate ?? 'fast';
    this.vlanAwareValue = spec.slbVlanAware ?? true;
    this.initialActiveValue = spec.initialActive;
    this.lastRebalance = env.now();
  }

  get mode(): BondMode {
    return this.modeValue;
  }
  /** Active members (the configured uplinks), in priority order. */
  get uplinks(): readonly string[] {
    return this.uplinksValue;
  }
  /** Every cabled NIC that may be chosen as an uplink (superset of `uplinks`). */
  get members(): readonly string[] {
    return this.cabledValue;
  }
  get lacpRate(): LacpRate {
    return this.rate;
  }
  get slbVlanAware(): boolean {
    return this.vlanAwareValue;
  }
  get activeMember(): string | null {
    return this.active;
  }
  /** Member preferred whenever active-backup chooses a new active member (`set-active-slave`). */
  get initialActive(): string | undefined {
    return this.initialActiveValue;
  }
  /** balance-tcp fell back to active-backup because no member is LACP-negotiated. */
  get lacpFallback(): boolean {
    return this.fallbackValue;
  }
  /** Uplinks that may carry traffic, in uplink order (before VLAN filtering). */
  get eligible(): readonly string[] {
    return this.eligibleList;
  }
  /** Set when the LACP partners do not form one aggregator (e.g. two switches, no MLAG). */
  get misconfig(): string | null {
    return this.misconfigValue;
  }
  private get usesLacp(): boolean {
    return this.modeValue === 'balance-tcp';
  }
  private get hashed(): boolean {
    return this.modeValue === 'balance-slb' || this.modeValue === 'balance-tcp';
  }
  /** VLAN filtering applies to balance-slb and active-backup when the flag is on. */
  private get filtersVlans(): boolean {
    return (
      this.vlanAwareValue &&
      (this.modeValue === 'balance-slb' || this.modeValue === 'active-backup')
    );
  }
  /** Forwarding uses one active member: active-backup, or balance-tcp in LACP fallback. */
  private get singleActive(): boolean {
    return this.modeValue === 'active-backup' || this.fallbackValue;
  }

  // ── Runtime configuration (SPEC §5.5) ─────────────────────────────────────

  setMode(mode: BondMode): void {
    if (mode === this.modeValue) return;
    const from = this.modeValue;
    this.modeValue = mode;
    this.resetForwarding();
    this.env.emit({
      severity: 'info',
      deviceId: this.id,
      code: 'net.bond.mode-changed',
      text: `${this.label}: bond mode ${from} → ${mode}`,
    });
  }

  /** Replace the active uplinks; the caller checks they are cabled members. */
  setUplinks(uplinks: readonly string[]): void {
    this.uplinksValue = [...uplinks];
    for (const nic of [...this.lacpTimers.keys()]) {
      if (!uplinks.includes(nic)) this.cancelLacpTimer(nic);
    }
    for (const nic of [...this.lacpDown]) if (!uplinks.includes(nic)) this.lacpDown.delete(nic);
    if (this.active !== null && !uplinks.includes(this.active)) this.active = null;
    this.env.emit({
      severity: 'info',
      deviceId: this.id,
      code: 'net.bond.uplinks-changed',
      text: `${this.label}: uplinks set to [${uplinks.join(', ')}]`,
    });
  }

  setLacpRate(rate: LacpRate): void {
    if (rate === this.rate) return;
    this.rate = rate;
    // Restart pending detections at the new rate.
    for (const nic of [...this.lacpTimers.keys()]) this.cancelLacpTimer(nic);
    this.env.emit({
      severity: 'info',
      deviceId: this.id,
      code: 'net.bond.lacp-rate-changed',
      text: `${this.label}: LACP rate ${rate}`,
    });
  }

  setSlbVlanAware(on: boolean): void {
    if (on === this.vlanAwareValue) return;
    this.vlanAwareValue = on;
    this.env.emit({
      severity: 'info',
      deviceId: this.id,
      code: 'net.bond.vlan-aware-changed',
      text: `${this.label}: VLAN-aware member selection ${on ? 'on' : 'off (plain OVS)'}`,
    });
  }

  private resetForwarding(): void {
    for (const nic of [...this.lacpTimers.keys()]) this.cancelLacpTimer(nic);
    this.lacpDown.clear();
    this.active = null;
    this.fallbackValue = false;
    this.buckets = new Array<string | null>(BOND_BUCKETS).fill(null);
    this.bucketLoad = new Array<number>(BOND_BUCKETS).fill(0);
    this.bucketVlans = new Map();
    this.forced = new Map();
    this.rr = 0;
  }

  private cancelLacpTimer(nic: string): void {
    const h = this.lacpTimers.get(nic);
    if (h) this.env.timers.cancel(h);
    this.lacpTimers.delete(nic);
    this.lacpStart.delete(nic);
  }

  // ── State reconciliation ──────────────────────────────────────────────────

  /** Recompute member eligibility from probes; start/cancel LACP detection; emit transitions. */
  reconcile(): void {
    const ups = this.uplinksValue;
    const probes = new Map(ups.map((m) => [m, this.env.probe(m)] as const));
    const probeOf = (m: string): MemberProbe =>
      probes.get(m) ?? { carrier: false, hung: false, partnerKey: null, causeIds: [] };

    for (const m of ups) {
      const p = probeOf(m);
      if (this.usesLacp && p.carrier && p.hung) {
        if (!this.lacpDown.has(m) && !this.lacpTimers.has(m)) this.startLacpTimer(m);
      } else {
        this.cancelLacpTimer(m);
        this.lacpDown.delete(m);
      }
    }

    const live = ups.filter((m) => probeOf(m).carrier && !this.lacpDown.has(m));
    const withCarrier = ups.filter((m) => probeOf(m).carrier);
    let eligible: string[];
    const detached = new Set<string>();
    let misconfig: string | null = null;
    const prevFallback = this.fallbackValue;
    this.fallbackValue = false;

    if (this.modeValue === 'no-bond') {
      const first = ups[0];
      eligible = first !== undefined && live.includes(first) ? [first] : [];
    } else if (this.usesLacp && live.length === 0 && withCarrier.length > 0) {
      // Every member with carrier has timed out: no negotiated lead, so with fallback-ab they
      // all stay attached and the bond runs active-backup over them; without it, it is down.
      this.fallbackValue = this.env.config().lacpFallbackAb;
      eligible = this.fallbackValue ? withCarrier : [];
    } else if (this.usesLacp) {
      const partners = [...new Set(ups.flatMap((m) => probeOf(m).partnerKey ?? []))].sort();
      if (partners.length > 1) {
        misconfig = `lacp-no-mlag: uplinks reach ${partners.length} LACP partners without a shared MLAG domain (${partners.join(', ')})`;
      }
      // One aggregator: the partner group with the most live members (ties: uplink order).
      const groups = new Map<string, string[]>();
      for (const m of live) {
        const key = probeOf(m).partnerKey ?? `none:${m}`;
        groups.set(key, [...(groups.get(key) ?? []), m]);
      }
      let best: string[] = [];
      for (const g of groups.values()) if (g.length > best.length) best = g;
      eligible = best;
      for (const m of live) if (!best.includes(m)) detached.add(m);
    } else {
      eligible = live;
    }

    const prevEligible = new Set(this.eligibleList);
    const prevActive = this.active;
    this.eligibleList = eligible;
    this.detachedSet = detached;
    // A forced pin lasts until its member leaves service; failover then re-pins normally.
    for (const [b, m] of [...this.forced]) if (!eligible.includes(m)) this.forced.delete(b);

    if (this.singleActive) {
      if (this.active === null || !eligible.includes(this.active)) {
        const pref = this.initialActiveValue;
        this.active = pref !== undefined && eligible.includes(pref) ? pref : (eligible[0] ?? null);
      }
    } else {
      this.active = null;
    }

    if (misconfig !== this.misconfigValue) {
      this.misconfigValue = misconfig;
      this.env.emit(
        misconfig
          ? {
              severity: 'warn',
              deviceId: this.id,
              code: 'net.bond.lacp-no-mlag',
              text: `${this.label}: LACP across switches without MLAG; only one switch's uplinks aggregate`,
            }
          : {
              severity: 'info',
              deviceId: this.id,
              code: 'net.bond.lacp-aggregated',
              text: `${this.label}: all LACP uplinks reach one partner`,
            },
      );
    }

    if (!this.initialized) {
      this.initialized = true;
      return;
    }

    if (this.fallbackValue !== prevFallback) {
      this.env.emit(
        this.fallbackValue
          ? {
              severity: 'warn',
              deviceId: this.id,
              code: 'net.bond.lacp-fallback',
              text: `${this.label}: no member is LACP-negotiated; lacp-fallback-ab runs active-backup on ${this.active ?? 'none'}`,
            }
          : {
              severity: 'info',
              deviceId: this.id,
              code: 'net.bond.lacp-negotiated',
              text: `${this.label}: LACP negotiated again; leaving active-backup fallback`,
            },
      );
    }

    for (const m of ups) {
      const was = prevEligible.has(m);
      const is = eligible.includes(m);
      if (was === is) continue;
      const p = probeOf(m);
      const why = !p.carrier
        ? 'carrier loss'
        : this.fallbackValue
          ? 'LACP fallback'
          : this.lacpDown.has(m)
            ? 'LACP timeout'
            : detached.has(m)
              ? 'not in LACP aggregator'
              : 'unused in no-bond mode';
      this.env.emit({
        severity: is ? 'info' : 'warn',
        deviceId: this.id,
        code: is ? 'net.bond.member-up' : 'net.bond.member-down',
        text: is
          ? `${this.label}: ${m} back in service${this.fallbackValue ? ' (active-backup fallback)' : ''}`
          : `${this.label}: ${m} removed (${why})`,
        causeIds: [...this.env.causes(), ...p.causeIds],
      });
    }
    if (prevActive !== this.active && prevActive !== null && this.active !== null) {
      this.env.emit({
        severity: 'warn',
        deviceId: this.id,
        code: 'net.bond.failover',
        text: `${this.label}: active member ${prevActive} → ${this.active}`,
        causeIds: [...this.env.causes(), ...probeOf(prevActive).causeIds],
      });
    }
    if (this.hashed) {
      const gone = [...prevEligible].filter((m) => !eligible.includes(m));
      if (gone.length > 0) this.failoverBuckets(gone, (m) => probeOf(m).causeIds);
    }
    if (prevEligible.size > 0 && eligible.length === 0) {
      this.env.emit({
        severity: 'error',
        deviceId: this.id,
        code: 'net.bond.down',
        text: `${this.label}: no usable uplink`,
      });
    }
  }

  /**
   * Hashed-mode failover (SPEC §5.3 "On failover, the vNICs or flows on the dead member move to a
   * survivor"; OVS bonding: buckets of a disabled member are redistributed at once). Buckets that
   * were on a member that just left service move to a survivor now, so the view and the switches'
   * MAC learning follow immediately. With VLAN awareness (balance-slb) a bucket only moves to a
   * member that carries all its VLANs; if none does it is left unassigned (`stranded`), which is
   * the isolated-VLAN case of SPEC §6.5 (`assumption`). Emits `net.bond.failover` if anything
   * moved, and `net.bond.vlan-stranded` for buckets with nowhere to go.
   */
  private failoverBuckets(gone: readonly string[], causesOf: (m: string) => readonly string[]) {
    const lost = new Set(gone);
    const moves = new Map<string, number>();
    let stranded = 0;
    const strandedVlans = new Set<number>();
    for (let b = 0; b < BOND_BUCKETS; b++) {
      const from = this.buckets[b];
      if (from == null || !lost.has(from)) continue;
      const to = this.eligibleList.filter((m) => this.canHost(b, m));
      const pick = to.length > 0 ? (to[this.rr++ % to.length] ?? null) : null;
      this.buckets[b] = pick;
      if (pick === null) {
        stranded++;
        for (const v of this.bucketVlans.get(b) ?? []) strandedVlans.add(v);
        continue;
      }
      const key = `${from} → ${pick}`;
      moves.set(key, (moves.get(key) ?? 0) + 1);
    }
    const causeIds = [...this.env.causes(), ...gone.flatMap(causesOf)];
    if (moves.size > 0) {
      const what = this.modeValue === 'balance-slb' ? 'vNIC (MAC+VLAN)' : 'flow';
      this.env.emit({
        severity: 'warn',
        deviceId: this.id,
        code: 'net.bond.failover',
        text: `${this.label}: ${what} hash buckets moved off failed member(s): ${[...moves]
          .map(([k, n]) => `${n} ${k}`)
          .join(', ')}`,
        causeIds,
      });
    }
    // With no member left at all, `net.bond.down` already says everything.
    if (stranded > 0 && this.eligibleList.length > 0) {
      this.env.emit({
        severity: 'warn',
        deviceId: this.id,
        code: 'net.bond.vlan-stranded',
        text: `${this.label}: ${stranded} vNIC hash bucket(s) on VLAN ${[...strandedVlans]
          .sort((x, y) => x - y)
          .join(', ')} have no surviving member that carries the VLAN; their traffic stops`,
        causeIds,
      });
    }
  }

  /**
   * LACP detection of a hung member (SPEC §5.3: fast ≤3 s, slow ≤90 s, AHV Admin Guide 11.2).
   * A member hung at the start of tick `t` is out of the aggregate from the start of tick
   * `t + detect`, before that tick's traffic, so its flows are blackholed for exactly `detect`
   * ticks (`inferred`: the real timeout counts from the last LACPDU, up to 1 s / 30 s before the
   * hang, so `detect` is the upper bound). The network calls `fireDueLacp` at the start of each
   * tick; the engine timer is kept so "fast-forward to next timer" sees the deadline, and fires
   * the same detection if nothing else did.
   */
  private startLacpTimer(nic: string): void {
    const cfg = this.env.config();
    const seconds = this.rate === 'fast' ? cfg.lacpFastDetectS : cfg.lacpSlowDetectS;
    const startCauses = this.env.causes();
    const handle = this.env.timers.set(
      this.id,
      `lacp-detect ${this.id}/${nic} (${this.rate})`,
      seconds,
      { cite: [], confidence: 'inferred' },
      () => this.lacpTimeout(nic),
    );
    this.lacpTimers.set(nic, handle);
    this.lacpStart.set(nic, { causes: startCauses, seconds });
  }

  /** Detect every hung member whose LACP deadline is due at `now` (start of tick). */
  fireDueLacp(now: SimTime): void {
    for (const [nic, h] of [...this.lacpTimers]) if (h.dueAt <= now) this.lacpTimeout(nic);
  }

  private lacpTimeout(nic: string): void {
    const h = this.lacpTimers.get(nic);
    if (!h) return;
    this.env.timers.cancel(h);
    this.lacpTimers.delete(nic);
    const start = this.lacpStart.get(nic);
    this.lacpStart.delete(nic);
    this.lacpDown.add(nic);
    const ev = this.env.emit({
      severity: 'warn',
      deviceId: this.id,
      code: 'net.bond.lacp-timeout',
      text: `${this.label}: no LACPDUs on ${nic} for ${start?.seconds ?? '?'}s (${this.rate} rate)`,
      causeIds: start?.causes ?? [],
    });
    this.env.withCauses([ev], () => this.env.reconcile());
  }

  // ── Forwarding ────────────────────────────────────────────────────────────

  /** Members usable for frames on `vlan` (VLAN-filtered when VLAN awareness applies). */
  usableFor(vlan: number): readonly string[] {
    return this.filtersVlans
      ? this.eligibleList.filter((m) => this.env.carries(m, vlan))
      : this.eligibleList;
  }

  /** The active-backup member used for `vlan`: the active one, or (VLAN-aware) a backup. */
  private activeFor(vlan: number): string | null {
    if (this.active === null) return null;
    if (this.fallbackValue) return this.active;
    if (!this.filtersVlans || this.env.carries(this.active, vlan)) return this.active;
    return this.usableFor(vlan)[0] ?? null;
  }

  /**
   * Side-effect-free view of where a source MAC on `vlan` egresses (view field `pinning`):
   * per-MAC modes only; `balance-tcp` hashes per flow, so it returns `null`. An SLB bucket that
   * has not carried traffic yet is unpinned (`null`).
   */
  viewPin(mac: string, vlan: number): string | null {
    if (this.fallbackValue) return this.activeFor(vlan);
    switch (this.modeValue) {
      case 'active-backup':
        return this.activeFor(vlan);
      case 'no-bond':
        return this.eligibleList[0] ?? null;
      case 'balance-slb': {
        const b = slbBucket(mac, vlan);
        const forced = this.forced.get(b);
        if (forced !== undefined) return forced;
        const m = this.buckets[b] ?? null;
        return m !== null && this.usableFor(vlan).includes(m) ? m : null;
      }
      case 'balance-tcp':
        return null;
    }
  }

  /** Egress member for a flow on frame VLAN `vlan`, or `null` if none is usable. */
  selectEgress(flow: FlowId, vlan: number, weight = 1): string | null {
    if (this.fallbackValue) return this.activeFor(vlan);
    switch (this.modeValue) {
      case 'active-backup':
        return this.activeFor(vlan);
      case 'no-bond':
        return this.eligibleList[0] ?? null;
      case 'balance-slb':
      case 'balance-tcp': {
        const b = this.bucketOf(flow, vlan);
        const pinned = this.modeValue === 'balance-slb' ? this.forced.get(b) : undefined;
        const usable = pinned === undefined ? this.usableFor(vlan) : [pinned];
        if (usable.length === 0) return null;
        let m = this.buckets[b] ?? null;
        if (m === null || !usable.includes(m)) {
          m = usable[this.rr % usable.length] ?? null;
          this.rr++;
          this.buckets[b] = m;
        }
        this.bucketLoad[b] = (this.bucketLoad[b] ?? 0) + weight;
        let vl = this.bucketVlans.get(b);
        if (!vl) {
          vl = new Set();
          this.bucketVlans.set(b, vl);
        }
        vl.add(vlan);
        return m;
      }
    }
  }

  /**
   * Members on which frames *to* `mac` on `vlan` are accepted: where the switches learned the
   * MAC. Unknown MACs (SLB bucket not yet used) flood, so any usable member works.
   */
  ingress(mac: string, vlan: number): readonly string[] {
    if (this.fallbackValue) {
      const a = this.activeFor(vlan);
      return a === null ? [] : [a];
    }
    switch (this.modeValue) {
      case 'active-backup': {
        const a = this.activeFor(vlan);
        return a === null ? [] : [a];
      }
      case 'no-bond':
      case 'balance-tcp':
        return this.eligibleList;
      case 'balance-slb': {
        const pinned = this.forced.get(slbBucket(mac, vlan));
        if (pinned !== undefined) return [pinned];
        const usable = this.usableFor(vlan);
        const m = this.buckets[slbBucket(mac, vlan)] ?? null;
        return m !== null && usable.includes(m) ? [m] : usable;
      }
    }
  }

  private bucketOf(flow: FlowId, vlan: number): number {
    return this.modeValue === 'balance-slb'
      ? slbBucket(flow.srcMac, vlan)
      : fnv1a(
          `${flow.srcMac}|${vlan}|${flow.srcIp}|${flow.dstIp}|${flow.srcPort}|${flow.dstPort}|${flow.proto}`,
        ) % BOND_BUCKETS;
  }

  /** May bucket `b` move to member `m` (VLAN awareness: `m` carries all its VLANs)? */
  private canHost(b: number, m: string): boolean {
    if (!this.filtersVlans) return true;
    for (const v of this.bucketVlans.get(b) ?? []) if (!this.env.carries(m, v)) return false;
    return true;
  }

  /**
   * Periodic rebalance (hashed modes), following OVS `bond_rebalance` (OVS bonding docs):
   * repeatedly move one bucket from the most-loaded member H to a less-loaded member L allowed
   * to take it, then reset the load counters. Returns buckets moved. A move needs:
   * - H to carry at least 2 hashes with traffic ("shifting load away from it would be
   *   pointless" otherwise);
   * - H's extra load over L to be at least 3 % of L's (OVS: `overload < to >> 5` stops);
   * - the move to narrow the gap by at least a tenth of the distance to an even split.
   * OVS also skips imbalances under about 1 Mbps; loads here are message counts, not bytes, so
   * that floor is not modeled.
   */
  maybeRebalance(now: SimTime): number {
    if (now - this.lastRebalance < this.env.config().slbRebalanceIntervalS) return 0;
    this.lastRebalance = now;
    let moved = 0;
    if (this.hashed && !this.fallbackValue && this.eligibleList.length > 1) {
      for (let guard = 0; guard < BOND_BUCKETS; guard++) {
        const load = new Map<string, number>(this.eligibleList.map((m) => [m, 0]));
        this.buckets.forEach((m, b) => {
          if (m !== null && load.has(m))
            load.set(m, (load.get(m) ?? 0) + (this.bucketLoad[b] ?? 0));
        });
        let from = this.eligibleList[0] ?? '';
        for (const m of this.eligibleList) if ((load.get(m) ?? 0) > (load.get(from) ?? 0)) from = m;
        const fromLoad = load.get(from) ?? 0;
        let hashes = 0;
        for (let b = 0; b < BOND_BUCKETS; b++) {
          if (this.buckets[b] === from && (this.bucketLoad[b] ?? 0) > 0) hashes++;
        }
        if (hashes < 2) break;
        let pick = -1;
        let pickTo = '';
        let pickGap = Number.POSITIVE_INFINITY;
        for (let b = 0; b < BOND_BUCKETS; b++) {
          const l = this.bucketLoad[b] ?? 0;
          if (this.buckets[b] !== from || l <= 0 || this.forced.has(b)) continue;
          for (const to of this.eligibleList) {
            const toLoad = load.get(to) ?? 0;
            const delta = fromLoad - toLoad;
            if (to === from || !this.canHost(b, to) || delta * 32 < toLoad) continue;
            const newLow = Math.min(fromLoad - l, toLoad + l);
            if (newLow <= toLoad || newLow - toLoad < delta / 20) continue;
            const gap = Math.abs(delta - 2 * l);
            if (gap < pickGap) {
              pick = b;
              pickTo = to;
              pickGap = gap;
            }
          }
        }
        if (pick < 0) break;
        this.buckets[pick] = pickTo;
        moved++;
      }
      if (moved > 0) {
        this.env.emit({
          severity: 'debug',
          deviceId: this.id,
          code: 'net.bond.rebalance',
          text: `${this.label}: rebalanced ${moved} hash bucket(s)`,
        });
      }
    }
    this.bucketLoad.fill(0);
    return moved;
  }

  /**
   * `vswitch.rebalance`: move the balance-slb bucket of one source MAC + VLAN onto `member`, as a
   * load rebalance would (SPEC §7.2 T1-16). Plain-OVS semantics: the pin ignores VLAN awareness,
   * so a VLAN can be stranded on a member whose switch does not carry it (OVS bonding docs:
   * rebalancing moves hash buckets by load only). Periodic rebalancing leaves the bucket alone;
   * the pin lasts until `member` leaves service. Emits `net.bond.rebalance`; returns its id.
   */
  forcePin(mac: string, vlan: number, member: string, vnic: string): string {
    if (this.modeValue !== 'balance-slb') {
      throw new NetworkError(`bond ${this.id}: rebalance needs balance-slb, not ${this.modeValue}`);
    }
    if (!this.eligibleList.includes(member)) {
      throw new NetworkError(`bond ${this.id}: '${member}' is not an in-service member`);
    }
    const b = slbBucket(mac, vlan);
    const from = this.buckets[b] ?? null;
    this.buckets[b] = member;
    this.forced.set(b, member);
    let vl = this.bucketVlans.get(b);
    if (!vl) {
      vl = new Set();
      this.bucketVlans.set(b, vl);
    }
    vl.add(vlan);
    return this.env.emit({
      severity: 'info',
      deviceId: this.id,
      code: 'net.bond.rebalance',
      text: `${this.label}: rebalance pinned ${vnic} (VLAN ${vlan}) ${from ?? 'unassigned'} → ${member}`,
    });
  }

  // ── View ──────────────────────────────────────────────────────────────────

  memberState(nic: string): MemberState {
    if (!this.uplinksValue.includes(nic)) return 'not-uplink';
    if (this.modeValue === 'no-bond' && nic !== this.uplinksValue[0]) return 'unused';
    if (this.fallbackValue && this.eligibleList.includes(nic)) {
      return nic === this.active ? 'active' : 'backup';
    }
    if (this.lacpDown.has(nic)) return 'lacp-down';
    if (this.detachedSet.has(nic)) return 'detached';
    if (!this.eligibleList.includes(nic)) return 'down';
    if (this.modeValue === 'active-backup') return nic === this.active ? 'active' : 'backup';
    return 'up';
  }

  /** Bucket count per eligible member (hashed modes): the pinning spread. */
  bucketSpread(): Readonly<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const m of this.eligibleList) out[m] = 0;
    for (const m of this.buckets) if (m !== null && m in out) out[m] = (out[m] ?? 0) + 1;
    return out;
  }

  /** Current member pinned for a (MAC, VLAN) in `balance-slb`, if assigned. */
  pinnedMember(mac: string, vlan: number): string | null {
    return this.buckets[slbBucket(mac, vlan)] ?? null;
  }

  status(): DeviceStatus {
    if (this.eligibleList.length === 0) return 'failed';
    const usable = this.modeValue === 'no-bond' ? 1 : this.uplinksValue.length;
    return this.eligibleList.length < usable || this.misconfigValue || this.fallbackValue
      ? 'degraded'
      : 'healthy';
  }

  fields(): Record<string, ViewField> {
    const f: Record<string, ViewField> = {
      net: 'bond',
      mode: this.modeValue,
      uplinks: this.uplinksValue.join(','),
      members: JSON.stringify(this.cabledValue),
      eligible: this.eligibleList.join(','),
      misconfig: this.misconfigValue,
    };
    if (this.group !== undefined) f.group = this.group;
    f.lacpRate = this.usesLacp ? this.rate : null;
    if (this.modeValue === 'balance-slb' || this.modeValue === 'active-backup') {
      f.slbVlanAware = this.vlanAwareValue;
    }
    if (this.singleActive) f.active = this.active;
    for (const m of this.cabledValue) f[`member.${m}`] = this.memberState(m);
    // View-field contract names (docs/view-fields.md, vswitch).
    const states = this.cabledValue.map((m) => this.memberState(m));
    f.bondMode = this.modeValue;
    f.activeMembers = states.filter((st) => st === 'active' || st === 'up').length;
    f.activeMember = this.singleActive
      ? (this.active ?? null)
      : this.modeValue === 'no-bond'
        ? (this.cabledValue.find((m) => this.memberState(m) === 'up') ?? null)
        : null;
    f.initialActive = this.modeValue === 'active-backup' ? (this.initialActiveValue ?? null) : null;
    f.lacpState = !this.usesLacp
      ? null
      : this.fallbackValue
        ? 'fallback'
        : states.every((st) => st === 'lacp-down' || st === 'down' || st === 'not-uplink')
          ? 'down'
          : states.some((st) => st === 'detached' || st === 'lacp-down')
            ? 'partial'
            : 'negotiated';
    if (this.hashed && !this.fallbackValue) {
      for (const [m, n] of Object.entries(this.bucketSpread())) f[`buckets.${m}`] = n;
    }
    return f;
  }
}

function slbBucket(mac: string, vlan: number): number {
  return fnv1a(`${mac}|${vlan}`) % BOND_BUCKETS;
}
