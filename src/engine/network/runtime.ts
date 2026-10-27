/**
 * Network runtime (SPEC §5.3): live L2 state, failure injection, frame delivery and per-link
 * utilization. Delivery is a deterministic BFS over up links in the frame's VLAN; every message
 * yields a route result that becomes its `Trace` (SPEC §5.4).
 */
import type { TimerQueue } from '../clock';
import type {
  DeviceId,
  DeviceStatus,
  DeviceView,
  DropReason,
  EndpointId,
  EventDraft,
  FlowId,
  LinkId,
  LinkView,
  MsgSize,
  SimTime,
  TrafficCategory,
  ViewField,
} from '../types';
import { BondRuntime, type MemberProbe, type MemberState } from './bond';
import {
  type BondMode,
  type BridgeSpec,
  DEFAULT_NETWORK_CONFIG,
  type EndpointAttach,
  type EndpointSpec,
  type LacpRate,
  type LinkSpec,
  type NetworkConfig,
  NetworkError,
  type NetworkSpec,
  type NicSpec,
  type SwitchSpec,
  validateNetworkSpec,
} from './spec';

/** What the network needs from the simulation that hosts it. */
export interface NetworkHost {
  now(): SimTime;
  readonly timers: TimerQueue;
  /** True if device `id` (or an ancestor) has been failed. */
  isDown(id: string): boolean;
  emit(draft: EventDraft): string;
  /** Event ids explaining the current change (e.g. the action being applied). */
  causes(): readonly string[];
  withCauses(causes: readonly string[], fn: () => void): void;
}

export type NetElementKind = 'nic' | 'switch' | 'bond' | 'bridge' | 'link' | 'endpoint';

export interface RouteRequest {
  readonly src: EndpointId;
  readonly dst: EndpointId;
  readonly size: MsgSize;
  readonly flow: FlowId;
}

export interface RouteResult {
  readonly delivered: boolean;
  /** Links traversed in order, including the one the frame was dropped on. */
  readonly links: readonly LinkId[];
  /** Links fully carried before any drop (what utilization counts). */
  readonly carried: readonly LinkId[];
  readonly dropAt?: string;
  readonly reason?: DropReason;
  /** Finer cause than `reason`, e.g. `hung` or `no-vlan-route`. */
  readonly detail?: string;
  /** Sum of `latencyMs` over carried links (illustrative). */
  readonly latencyMs: number;
  /** Egress NIC chosen at the source (after bond selection), if any. */
  readonly egress?: string;
}

/** Read-only bond state for inspectors and domain logic (e.g. the path-usage view). */
export interface BondInfo {
  readonly id: string;
  readonly mode: BondMode;
  /** Active members, in priority order. */
  readonly uplinks: readonly string[];
  /** Cabled NICs (superset of `uplinks`). */
  readonly members: readonly string[];
  readonly eligible: readonly string[];
  readonly slbVlanAware: boolean;
  readonly activeMember: string | null;
  readonly lacpRate: LacpRate;
  readonly misconfig: string | null;
  readonly group: string | undefined;
  memberState(nic: string): MemberState;
  /** Eligible members that may carry `vlan` (after VLAN-aware filtering). */
  usableFor(vlan: number): readonly string[];
  pinnedMember(mac: string, vlan: number): string | null;
  bucketSpread(): Readonly<Record<string, number>>;
}

export interface LinkInfo {
  readonly id: LinkId;
  readonly a: string;
  readonly b: string;
  readonly adminUp: boolean;
  readonly hung: boolean;
  readonly status: 'up' | 'down';
  readonly mtu: number;
  readonly latencyMs: number;
  readonly allowedVlans: readonly number[] | null;
}

/** The read-only face of the network that devices, actions and the UI may use. */
export interface NetworkQuery {
  kindOf(id: string): NetElementKind | undefined;
  endpoint(id: EndpointId): EndpointSpec | undefined;
  endpointUp(id: EndpointId): boolean;
  endpointsOf(owner: DeviceId): readonly EndpointSpec[];
  bond(id: string): BondInfo | undefined;
  bondsInGroup(id: string): readonly string[];
  link(id: LinkId): LinkInfo | undefined;
  /** Hung flag of a link, NIC or switch. */
  isHung(id: string): boolean;
  /** Admin state of a link, NIC, switch or endpoint (device failures are separate). */
  isAdminUp(id: string): boolean;
  /** Every VLAN that appears on a switch, link or endpoint, sorted. */
  vlans(): readonly number[];
  utilization(link: LinkId): Readonly<Record<TrafficCategory, number>>;
  /** Build a flow identity for a message between two endpoints. */
  flow(
    src: EndpointId,
    dst: EndpointId,
    l4?: { srcPort?: number; dstPort?: number; proto?: FlowId['proto'] },
  ): FlowId;
}

interface NicState {
  readonly spec: NicSpec;
  readonly mtu: number;
  adminUp: boolean;
  hung: boolean;
}
interface SwitchState {
  readonly spec: SwitchSpec;
  readonly mtu: number;
  readonly vlans: ReadonlySet<number>;
  adminUp: boolean;
  hung: boolean;
  domain: string | undefined;
  mlagEnabled: boolean;
}
interface LinkState {
  readonly spec: LinkSpec;
  readonly mtu: number;
  readonly aPort: string;
  readonly bPort: string;
  adminUp: boolean;
  hung: boolean;
  latencyMs: number;
  allowed: Set<number> | null;
}
interface EndpointState {
  readonly spec: EndpointSpec;
  attach: EndpointAttach;
  readonly mtu: number;
  adminUp: boolean;
  fenced: boolean;
}

interface Fault {
  readonly reason: DropReason;
  readonly at: string;
  readonly detail?: string;
}
interface Relax {
  readonly status: boolean;
  readonly vlan: boolean;
  readonly mtu: boolean;
}
const STRICT: Relax = { status: false, vlan: false, mtu: false };
const RELAXATIONS: readonly Relax[] = [
  STRICT,
  { status: true, vlan: false, mtu: false },
  { status: true, vlan: true, mtu: false },
  { status: true, vlan: true, mtu: true },
];

const DEFAULT_NIC_MTU = 1500;
const DEFAULT_SWITCH_MTU = 9216;
const DEFAULT_ENDPOINT_MTU = 1500;

export class NetworkRuntime implements NetworkQuery {
  readonly config: NetworkConfig;
  private readonly nics = new Map<string, NicState>();
  private readonly switches = new Map<string, SwitchState>();
  private readonly links = new Map<LinkId, LinkState>();
  private readonly bonds = new Map<string, BondRuntime>();
  private readonly bridges = new Map<string, BridgeSpec>();
  private readonly endpoints = new Map<EndpointId, EndpointState>();
  private readonly adjacency = new Map<string, LinkId[]>();
  private readonly nicLink = new Map<string, LinkId>();
  private readonly bondOfNic = new Map<string, string>();
  private readonly util = new Map<LinkId, Map<TrafficCategory, number>>();
  private linkStatus = new Map<LinkId, 'up' | 'down'>();
  private linkEvents = new Map<LinkId, string>();
  private reconciling = false;

  constructor(
    spec: NetworkSpec,
    private readonly host: NetworkHost,
  ) {
    validateNetworkSpec(spec);
    this.config = { ...DEFAULT_NETWORK_CONFIG, ...stripUndefined(spec.config ?? {}) };

    for (const n of spec.nics ?? []) {
      this.nics.set(n.id, { spec: n, mtu: n.mtu ?? DEFAULT_NIC_MTU, adminUp: true, hung: false });
    }
    for (const s of spec.switches ?? []) {
      this.switches.set(s.id, {
        spec: s,
        mtu: s.mtu ?? DEFAULT_SWITCH_MTU,
        vlans: new Set(s.vlans),
        adminUp: true,
        hung: false,
        domain: s.mlagDomain,
        mlagEnabled: s.mlagDomain !== undefined,
      });
    }
    const sortedLinks = [...(spec.links ?? [])].sort((x, y) => cmp(x.id, y.id));
    const portCounter = new Map<string, number>();
    const portName = (end: string, given: string | undefined): string => {
      if (given !== undefined) return given;
      if (this.nics.has(end)) return 'p0';
      const n = (portCounter.get(end) ?? 0) + 1;
      portCounter.set(end, n);
      return `p${n}`;
    };
    for (const l of sortedLinks) {
      this.links.set(l.id, {
        spec: l,
        mtu: l.mtu ?? Math.min(this.endMtu(l.a), this.endMtu(l.b)),
        aPort: portName(l.a, l.aPort),
        bPort: portName(l.b, l.bPort),
        adminUp: true,
        hung: false,
        latencyMs: l.latencyMs ?? 0,
        allowed: l.allowedVlans ? new Set(l.allowedVlans) : null,
      });
      for (const end of [l.a, l.b]) {
        this.adjacency.set(end, [...(this.adjacency.get(end) ?? []), l.id]);
        if (this.nics.has(end)) this.nicLink.set(end, l.id);
      }
    }
    for (const b of spec.bridges ?? []) this.bridges.set(b.id, b);
    for (const e of spec.endpoints ?? []) {
      this.endpoints.set(e.id, {
        spec: e,
        attach: e.attach,
        mtu: e.mtu ?? DEFAULT_ENDPOINT_MTU,
        adminUp: true,
        fenced: false,
      });
    }
    for (const b of spec.bonds ?? []) {
      for (const m of b.members ?? b.uplinks) this.bondOfNic.set(m, b.id);
      this.bonds.set(
        b.id,
        new BondRuntime(b, {
          now: () => this.host.now(),
          timers: this.host.timers,
          config: () => this.config,
          probe: (nic) => this.probeMember(nic),
          carries: (nic, vlan) => this.memberCarries(nic, vlan),
          emit: (d) =>
            this.host.emit({ ...d, causeIds: d.causeIds ?? this.host.causes(), cite: [] }),
          causes: () => this.host.causes(),
          withCauses: (c, fn) => this.host.withCauses(c, fn),
          reconcile: () => this.reconcile(),
        }),
      );
    }
    for (const id of this.links.keys()) this.linkStatus.set(id, this.computeLinkStatus(id));
    this.reconcile();
  }

  // ── Structure ─────────────────────────────────────────────────────────────

  kindOf(id: string): NetElementKind | undefined {
    if (this.nics.has(id)) return 'nic';
    if (this.switches.has(id)) return 'switch';
    if (this.bonds.has(id)) return 'bond';
    if (this.bridges.has(id)) return 'bridge';
    if (this.links.has(id)) return 'link';
    if (this.endpoints.has(id)) return 'endpoint';
    return undefined;
  }

  /** element id → owning device, for the simulation's ancestry map. */
  owners(): ReadonlyMap<string, DeviceId> {
    const out = new Map<string, DeviceId>();
    for (const [id, n] of this.nics) if (n.spec.owner !== undefined) out.set(id, n.spec.owner);
    for (const [id, b] of this.bonds) if (b.owner !== undefined) out.set(id, b.owner);
    for (const [id, b] of this.bridges) if (b.owner !== undefined) out.set(id, b.owner);
    return out;
  }

  /** The endpoint's spec with its current attachment (it may have been re-homed). */
  endpoint(id: EndpointId): EndpointSpec | undefined {
    const e = this.endpoints.get(id);
    return e && { ...e.spec, attach: e.attach };
  }

  endpointUp(id: EndpointId): boolean {
    const e = this.endpoints.get(id);
    return !!e && e.adminUp && !this.host.isDown(e.spec.owner);
  }

  endpointsOf(owner: DeviceId): readonly EndpointSpec[] {
    return [...this.endpoints.values()]
      .filter((e) => e.spec.owner === owner)
      .map((e) => ({ ...e.spec, attach: e.attach }));
  }

  bond(id: string): BondInfo | undefined {
    const b = this.bonds.get(id);
    if (!b) return undefined;
    return {
      id: b.id,
      mode: b.mode,
      uplinks: b.uplinks,
      members: b.members,
      eligible: b.eligible,
      slbVlanAware: b.slbVlanAware,
      activeMember: b.activeMember,
      lacpRate: b.lacpRate,
      misconfig: b.misconfig,
      group: b.group,
      memberState: (nic) => b.memberState(nic),
      usableFor: (vlan) => b.usableFor(vlan),
      pinnedMember: (mac, vlan) => b.pinnedMember(mac, vlan),
      bucketSpread: () => b.bucketSpread(),
    };
  }

  bondsInGroup(id: string): readonly string[] {
    const b = this.bonds.get(id);
    if (!b) return [];
    if (b.group === undefined) return [id];
    return [...this.bonds.values()].filter((x) => x.group === b.group).map((x) => x.id);
  }

  link(id: LinkId): LinkInfo | undefined {
    const l = this.links.get(id);
    if (!l) return undefined;
    return {
      id,
      a: l.spec.a,
      b: l.spec.b,
      adminUp: l.adminUp,
      hung: l.hung,
      status: this.computeLinkStatus(id),
      mtu: l.mtu,
      latencyMs: l.latencyMs,
      allowedVlans: l.allowed ? [...l.allowed].sort((x, y) => x - y) : null,
    };
  }

  isHung(id: string): boolean {
    return !!(this.links.get(id)?.hung || this.nics.get(id)?.hung || this.switches.get(id)?.hung);
  }

  isAdminUp(id: string): boolean {
    const el = this.links.get(id) ?? this.nics.get(id) ?? this.switches.get(id);
    if (el) return el.adminUp;
    return this.endpoints.get(id)?.adminUp ?? false;
  }

  vlans(): readonly number[] {
    const all = new Set<number>();
    for (const s of this.switches.values()) for (const v of s.vlans) all.add(v);
    for (const l of this.links.values()) for (const v of l.allowed ?? []) all.add(v);
    for (const e of this.endpoints.values()) all.add(e.spec.vlan);
    return [...all].sort((a, b) => a - b);
  }

  flow(
    src: EndpointId,
    dst: EndpointId,
    l4: { srcPort?: number; dstPort?: number; proto?: FlowId['proto'] } = {},
  ): FlowId {
    const se = this.requireEndpoint(src);
    const s = se.spec;
    const internal =
      se.attach.kind === 'bridge' && this.requireEndpoint(dst).attach.kind === 'bridge';
    const d = this.requireEndpoint(dst).spec;
    return {
      srcMac: s.mac,
      vlan: s.vlan,
      srcIp: s.ip,
      dstIp: d.ip,
      srcPort: l4.srcPort ?? 0,
      dstPort: l4.dstPort ?? 0,
      proto: l4.proto ?? (internal ? 'internal' : 'tcp'),
    };
  }

  // ── Failure injection and runtime configuration ───────────────────────────

  setLinkUp(id: LinkId, up: boolean): void {
    this.requireLink(id).adminUp = up;
    this.reconcile();
  }

  setNicUp(id: string, up: boolean): void {
    this.requireNic(id).adminUp = up;
    this.reconcile();
  }

  setSwitchUp(id: string, up: boolean): void {
    this.requireSwitch(id).adminUp = up;
    this.reconcile();
  }

  /** Hang a link, NIC or switch: carrier stays up but every frame is dropped. */
  setHung(id: string, hung: boolean): void {
    const el = this.links.get(id) ?? this.nics.get(id) ?? this.switches.get(id);
    if (!el) throw new NetworkError(`no link, NIC or switch '${id}'`);
    el.hung = hung;
    this.reconcile();
  }

  setLinkLatency(id: LinkId, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new NetworkError(`latency must be >= 0, got ${ms}`);
    this.requireLink(id).latencyMs = ms;
  }

  /** `null` allows every VLAN. */
  setAllowedVlans(id: LinkId, vlans: readonly number[] | null): void {
    this.requireLink(id).allowed = vlans === null ? null : new Set(vlans);
    this.reconcile();
  }

  pruneVlan(id: LinkId, vlan: number): void {
    const l = this.requireLink(id);
    const allowed = l.allowed ?? new Set(this.carriedByEnds(l));
    allowed.delete(vlan);
    l.allowed = allowed;
    this.reconcile();
  }

  allowVlan(id: LinkId, vlan: number): void {
    const l = this.requireLink(id);
    if (l.allowed === null) return;
    l.allowed.add(vlan);
    this.reconcile();
  }

  /**
   * Turn MLAG on/off. With `enabled = false`, every switch sharing the target's configured
   * domain leaves it. With `enabled = true`, `domain` (if given) sets the target's domain and the
   * switches configured with it rejoin.
   */
  setMlag(id: string, enabled: boolean, domain?: string): void {
    const sw = this.requireSwitch(id);
    if (domain !== undefined) sw.domain = domain;
    if (enabled && sw.domain === undefined) {
      throw new NetworkError(`switch ${id} has no MLAG domain to enable`);
    }
    for (const s of this.switches.values()) {
      if (s === sw || (s.domain !== undefined && s.domain === sw.domain)) s.mlagEnabled = enabled;
    }
    this.host.emit({
      severity: 'info',
      deviceId: id,
      code: 'net.mlag.changed',
      text: `MLAG ${enabled ? 'enabled' : 'disabled'} on domain ${sw.domain ?? id}`,
      causeIds: this.host.causes(),
      cite: [],
    });
    this.reconcile();
  }

  setEndpointUp(id: EndpointId, up: boolean): void {
    this.requireEndpoint(id).adminUp = up;
  }

  setEndpointFenced(id: EndpointId, fenced: boolean): void {
    this.requireEndpoint(id).fenced = fenced;
  }

  setBondMode(id: string, mode: BondMode): void {
    this.requireBond(id).setMode(mode);
    this.reconcile();
  }

  /** Choose the active uplinks from the bond's cabled members (`vswitch.set-uplinks`). */
  setBondUplinks(id: string, uplinks: readonly string[]): void {
    const bond = this.requireBond(id);
    for (const m of uplinks) {
      if (!bond.members.includes(m)) {
        throw new NetworkError(
          `bond ${id}: '${m}' is not a cabled member (${bond.members.join(', ')})`,
        );
      }
    }
    if (new Set(uplinks).size !== uplinks.length) {
      throw new NetworkError(`bond ${id}: duplicate uplinks`);
    }
    bond.setUplinks(uplinks);
    this.reconcile();
  }

  setSlbVlanAware(id: string, on: boolean): void {
    this.requireBond(id).setSlbVlanAware(on);
    this.reconcile();
  }

  /**
   * Re-home an endpoint (e.g. a floating VIP moving to the new primary controller's NIC).
   * Emits `net.endpoint.moved`; returns the event id.
   */
  moveEndpoint(id: EndpointId, attach: EndpointAttach): string {
    const e = this.requireEndpoint(id);
    if (this.kindOf(attach.id) !== attach.kind) {
      throw new NetworkError(`endpoint ${id}: no ${attach.kind} '${attach.id}'`);
    }
    const from = e.attach;
    e.attach = { kind: attach.kind, id: attach.id };
    return this.host.emit({
      severity: 'info',
      deviceId: e.spec.owner,
      code: 'net.endpoint.moved',
      text: `${id} moved from ${from.kind} ${from.id} to ${attach.kind} ${attach.id}`,
      causeIds: this.host.causes(),
      cite: [],
    });
  }

  setLacpRate(id: string, rate: LacpRate): void {
    this.requireBond(id).setLacpRate(rate);
    this.reconcile();
  }

  /**
   * `vswitch.rebalance`: pin the balance-slb bucket of endpoint `vnic` (a vNIC on bond `id`) to
   * `member`. Returns the `net.bond.rebalance` event id.
   */
  forceSlbPin(id: string, vnic: EndpointId, member: string): string {
    const bond = this.requireBond(id);
    const e = this.requireEndpoint(vnic);
    if (e.attach.kind !== 'bond' || e.attach.id !== id) {
      throw new NetworkError(`endpoint ${vnic} is not attached to bond ${id}`);
    }
    return bond.forcePin(e.spec.mac, e.spec.vlan, member, vnic);
  }

  // ── Tick integration ──────────────────────────────────────────────────────

  /** Clear last tick's utilization (start of tick). */
  beginTick(): void {
    this.util.clear();
  }

  /** Periodic work in the tick phase: hashed-bond rebalancing. */
  tick(now: SimTime): void {
    for (const b of this.sortedBonds()) b.maybeRebalance(now);
  }

  recordUtil(links: readonly LinkId[], category: TrafficCategory): void {
    for (const id of links) {
      let m = this.util.get(id);
      if (!m) {
        m = new Map();
        this.util.set(id, m);
      }
      m.set(category, (m.get(category) ?? 0) + 1);
    }
  }

  utilization(link: LinkId): Readonly<Record<TrafficCategory, number>> {
    const out: Record<TrafficCategory, number> = {};
    for (const [k, v] of [...(this.util.get(link) ?? new Map<string, number>())].sort((x, y) =>
      cmp(x[0], y[0]),
    )) {
      out[k] = v;
    }
    return out;
  }

  /**
   * Recompute link status and bond membership after any change; emits `net.link.*` transitions
   * and lets bonds react (failover, LACP detection timers). Re-entrant calls are folded.
   */
  reconcile(): void {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      this.linkEvents = new Map();
      for (const id of this.links.keys()) {
        const now = this.computeLinkStatus(id);
        if (now !== this.linkStatus.get(id)) {
          this.linkStatus.set(id, now);
          const ev = this.host.emit({
            severity: now === 'down' ? 'warn' : 'info',
            code: now === 'down' ? 'net.link.down' : 'net.link.up',
            text: `link ${id} ${now}`,
            causeIds: this.host.causes(),
            cite: [],
          });
          this.linkEvents.set(id, ev);
        }
      }
      for (const b of this.sortedBonds()) b.reconcile();
    } finally {
      this.reconciling = false;
    }
  }

  // ── Delivery ──────────────────────────────────────────────────────────────

  /**
   * Route one frame. Side effect: hashed bonds assign and count buckets for the flow.
   * Drops report the first failing element on the path the frame would have taken.
   */
  route(req: RouteRequest): RouteResult {
    const s = this.endpoints.get(req.src);
    const d = this.endpoints.get(req.dst);
    if (!s) return drop([], [], { reason: 'no-route', at: req.src, detail: 'unknown-source' });
    if (!d) return drop([], [], { reason: 'no-route', at: req.dst, detail: 'unknown-destination' });
    const srcFault = this.endpointFault(s);
    if (srcFault) return drop([], [], srcFault);
    const vlan = s.spec.vlan;
    if (d.spec.vlan !== vlan) {
      return drop([], [], { reason: 'no-route', at: d.spec.owner, detail: 'different-vlan' });
    }
    const need = req.size === 'large' ? s.mtu : 0;

    const sa = s.attach;
    const da = d.attach;
    if (sa.kind === da.kind && sa.id === da.id) {
      const attachFault = this.attachFault(sa.kind, sa.id);
      if (attachFault) return drop([], [], attachFault);
      return this.finish(d, need, [], []);
    }
    if (sa.kind === 'bridge' || da.kind === 'bridge') {
      const at = sa.kind === 'bridge' ? sa.id : da.id;
      return drop([], [], { reason: 'no-route', at, detail: 'bridge-has-no-uplink' });
    }

    let egress: string;
    if (sa.kind === 'bond') {
      const bond = this.requireBond(sa.id);
      const m = bond.selectEgress(req.flow, vlan, req.size === 'large' ? 8 : 1);
      if (m === null) {
        const detail = bond.eligible.length > 0 ? 'no-uplink-carries-vlan' : 'no-live-uplink';
        return drop([], [], { reason: 'bond-no-member', at: bond.id, detail });
      }
      egress = m;
    } else {
      egress = sa.id;
    }

    let accept: ReadonlySet<string>;
    let search: ReadonlySet<string>;
    let dstBond: string | undefined;
    if (da.kind === 'bond') {
      const bond = this.requireBond(da.id);
      dstBond = bond.id;
      accept = new Set(bond.ingress(d.spec.mac, vlan));
      search = accept.size > 0 ? accept : new Set(bond.uplinks);
    } else {
      accept = new Set([da.id]);
      search = accept;
    }

    let path: { links: LinkId[]; nodes: string[] } | null = null;
    for (const relax of RELAXATIONS) {
      path = this.bfs(egress, search, vlan, need, relax);
      if (path) break;
    }
    if (!path) {
      return withEgress(
        drop([], [], { reason: 'no-route', at: egress, detail: 'no-physical-path' }),
        egress,
      );
    }

    const startFault = this.nodeFault(egress, vlan, need, STRICT);
    if (startFault) return withEgress(drop([], [], startFault), egress);
    for (let i = 0; i < path.links.length; i++) {
      const linkId = path.links[i] as LinkId;
      const node = path.nodes[i + 1] as string;
      const fault =
        this.linkFault(linkId, vlan, need, STRICT) ?? this.nodeFault(node, vlan, need, STRICT);
      if (fault) {
        return withEgress(drop(path.links.slice(0, i + 1), path.links.slice(0, i), fault), egress);
      }
    }
    const last = path.nodes[path.nodes.length - 1] as string;
    if (!accept.has(last)) {
      return withEgress(
        drop(path.links, path.links.slice(0, -1), {
          reason: 'bond-no-member',
          at: dstBond ?? last,
          detail: 'ingress-member-not-active',
        }),
        egress,
      );
    }
    return withEgress(this.finish(d, need, path.links, path.links), egress);
  }

  /** Destination-side checks once the frame reached the destination's attachment. */
  private finish(
    d: EndpointState,
    need: number,
    links: readonly LinkId[],
    carried: readonly LinkId[],
  ): RouteResult {
    const latencyMs = carried.reduce((sum, id) => sum + (this.links.get(id)?.latencyMs ?? 0), 0);
    const fault =
      this.endpointFault(d) ??
      (need > d.mtu ? { reason: 'mtu' as const, at: d.spec.owner, detail: 'endpoint-mtu' } : null);
    if (fault) return { ...drop(links, carried, fault), latencyMs };
    return { delivered: true, links, carried, latencyMs };
  }

  private endpointFault(e: EndpointState): Fault | null {
    if (this.host.isDown(e.spec.owner)) return { reason: 'device-down', at: e.spec.owner };
    if (!e.adminUp) return { reason: 'endpoint-down', at: e.spec.owner, detail: e.spec.id };
    if (e.fenced) return { reason: 'fenced', at: e.spec.owner, detail: e.spec.id };
    return null;
  }

  private attachFault(kind: 'nic' | 'bond' | 'bridge', id: string): Fault | null {
    return this.host.isDown(id) ? { reason: 'device-down', at: id, detail: kind } : null;
  }

  private bfs(
    start: string,
    targets: ReadonlySet<string>,
    vlan: number,
    need: number,
    relax: Relax,
  ): { links: LinkId[]; nodes: string[] } | null {
    if (this.nodeFault(start, vlan, need, relax)) return null;
    const prev = new Map<string, { node: string; link: LinkId }>();
    const seen = new Set([start]);
    const queue = [start];
    const build = (end: string, via: { node: string; link: LinkId }) => {
      const links: LinkId[] = [via.link];
      const nodes: string[] = [end, via.node];
      let cur = via.node;
      for (let p = prev.get(cur); p; p = prev.get(cur)) {
        links.push(p.link);
        nodes.push(p.node);
        cur = p.node;
      }
      return { links: links.reverse(), nodes: nodes.reverse() };
    };
    for (let qi = 0; qi < queue.length; qi++) {
      const u = queue[qi] as string;
      for (const linkId of this.adjacency.get(u) ?? []) {
        const l = this.links.get(linkId);
        if (!l) continue;
        const v = l.spec.a === u ? l.spec.b : l.spec.a;
        if (seen.has(v) || this.linkFault(linkId, vlan, need, relax)) continue;
        if (this.nics.has(v)) {
          if (targets.has(v) && !this.nodeFault(v, vlan, need, relax)) {
            return build(v, { node: u, link: linkId });
          }
          continue; // NICs do not forward
        }
        if (this.nodeFault(v, vlan, need, relax)) continue;
        seen.add(v);
        prev.set(v, { node: u, link: linkId });
        queue.push(v);
      }
    }
    return null;
  }

  private linkFault(id: LinkId, vlan: number, need: number, relax: Relax): Fault | null {
    const l = this.links.get(id);
    if (!l) return { reason: 'no-route', at: id };
    if (!relax.status && !l.adminUp) return { reason: 'link-down', at: id };
    if (!relax.status && l.hung) return { reason: 'link-down', at: id, detail: 'hung' };
    if (!relax.vlan && l.allowed && !l.allowed.has(vlan)) {
      return { reason: 'vlan-not-carried', at: id };
    }
    if (!relax.mtu && need > l.mtu) return { reason: 'mtu', at: id };
    return null;
  }

  private nodeFault(id: string, vlan: number, need: number, relax: Relax): Fault | null {
    const nic = this.nics.get(id);
    if (nic) {
      if (!relax.status && (!nic.adminUp || this.host.isDown(id))) {
        return { reason: 'port-down', at: id };
      }
      if (!relax.status && nic.hung) return { reason: 'port-down', at: id, detail: 'hung' };
      if (!relax.mtu && need > nic.mtu) return { reason: 'mtu', at: id };
      return null;
    }
    const sw = this.switches.get(id);
    if (sw) {
      if (!relax.status && (!sw.adminUp || this.host.isDown(id))) {
        return { reason: 'device-down', at: id };
      }
      if (!relax.status && sw.hung) return { reason: 'device-down', at: id, detail: 'hung' };
      if (!relax.vlan && !sw.vlans.has(vlan)) return { reason: 'vlan-not-carried', at: id };
      if (!relax.mtu && need > sw.mtu) return { reason: 'mtu', at: id };
      return null;
    }
    return { reason: 'no-route', at: id };
  }

  // ── Element state helpers ─────────────────────────────────────────────────

  private endMtu(id: string): number {
    return this.nics.get(id)?.mtu ?? this.switches.get(id)?.mtu ?? DEFAULT_NIC_MTU;
  }

  private endUp(id: string): boolean {
    const n = this.nics.get(id);
    if (n) return n.adminUp && !this.host.isDown(id);
    const s = this.switches.get(id);
    return !!s && s.adminUp && !this.host.isDown(id);
  }

  private computeLinkStatus(id: LinkId): 'up' | 'down' {
    const l = this.links.get(id);
    return l?.adminUp && this.endUp(l.spec.a) && this.endUp(l.spec.b) ? 'up' : 'down';
  }

  private carriedByEnds(l: LinkState): number[] {
    const fromSwitches = [l.spec.a, l.spec.b].flatMap((e) => [
      ...(this.switches.get(e)?.vlans ?? []),
    ]);
    return fromSwitches.length > 0 ? fromSwitches : [...this.vlans()];
  }

  /** Configuration check: does the member's link and partner switch carry `vlan`? */
  private memberCarries(nic: string, vlan: number): boolean {
    const linkId = this.nicLink.get(nic);
    const l = linkId === undefined ? undefined : this.links.get(linkId);
    if (!l) return false;
    if (l.allowed && !l.allowed.has(vlan)) return false;
    const peer = l.spec.a === nic ? l.spec.b : l.spec.a;
    const sw = this.switches.get(peer);
    return !sw || sw.vlans.has(vlan);
  }

  private partnerKey(peer: string): string {
    const sw = this.switches.get(peer);
    if (!sw) return `nic:${peer}`;
    return sw.mlagEnabled && sw.domain !== undefined ? `mlag:${sw.domain}` : `switch:${peer}`;
  }

  private probeMember(nic: string): MemberProbe {
    const linkId = this.nicLink.get(nic);
    const l = linkId === undefined ? undefined : this.links.get(linkId);
    const n = this.nics.get(nic);
    if (!l || !n || linkId === undefined) {
      return { carrier: false, hung: false, partnerKey: null, causeIds: [] };
    }
    const peer = l.spec.a === nic ? l.spec.b : l.spec.a;
    const linkEvent = this.linkEvents.get(linkId);
    return {
      carrier: this.computeLinkStatus(linkId) === 'up',
      hung: n.hung || l.hung || this.isHung(peer),
      partnerKey: this.partnerKey(peer),
      causeIds: linkEvent === undefined ? [] : [linkEvent],
    };
  }

  private sortedBonds(): BondRuntime[] {
    return [...this.bonds.values()].sort((a, b) => cmp(a.id, b.id));
  }

  private requireLink(id: LinkId): LinkState {
    const l = this.links.get(id);
    if (!l) throw new NetworkError(`no link '${id}'`);
    return l;
  }
  private requireNic(id: string): NicState {
    const n = this.nics.get(id);
    if (!n) throw new NetworkError(`no NIC '${id}'`);
    return n;
  }
  private requireSwitch(id: string): SwitchState {
    const s = this.switches.get(id);
    if (!s) throw new NetworkError(`no switch '${id}'`);
    return s;
  }
  private requireBond(id: string): BondRuntime {
    const b = this.bonds.get(id);
    if (!b) throw new NetworkError(`no bond '${id}'`);
    return b;
  }
  private requireEndpoint(id: EndpointId): EndpointState {
    const e = this.endpoints.get(id);
    if (!e) throw new NetworkError(`no endpoint '${id}'`);
    return e;
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  linkViews(): LinkView[] {
    return [...this.links.entries()]
      .sort((x, y) => cmp(x[0], y[0]))
      .map(([id, l]) => ({
        id,
        a: { device: l.spec.a, port: l.aPort },
        b: { device: l.spec.b, port: l.bPort },
        status: this.computeLinkStatus(id),
        mtu: l.mtu,
        latencyMs: l.latencyMs,
        util: this.utilization(id),
      }));
  }

  /**
   * Views for NICs, switches and bonds. Status reflects network-local state only (admin down,
   * hung, bond health); the simulation overlays device failures.
   */
  elementViews(): DeviceView[] {
    const views: DeviceView[] = [];
    for (const [id, n] of this.nics) {
      const linkId = this.nicLink.get(id);
      const fields: Record<string, ViewField> = {
        net: 'nic',
        mtu: n.mtu,
        adminUp: n.adminUp,
        hung: n.hung,
        link: linkId ?? null,
        bond: this.bondOfNic.get(id) ?? null,
      };
      const status: DeviceStatus = !n.adminUp
        ? 'failed'
        : n.hung
          ? 'stalled'
          : linkId !== undefined && this.computeLinkStatus(linkId) === 'down'
            ? 'degraded'
            : 'healthy';
      views.push(view(id, 'nic', n.spec.label ?? id, n.spec.owner, status, fields));
    }
    for (const [id, s] of this.switches) {
      const fields: Record<string, ViewField> = {
        net: 'switch',
        vlans: [...s.vlans].sort((a, b) => a - b).join(','),
        mtu: s.mtu,
        adminUp: s.adminUp,
        hung: s.hung,
        mlagDomain: s.mlagEnabled ? (s.domain ?? null) : null,
        flowControl: s.spec.flowControl ?? 'off',
      };
      const status: DeviceStatus = !s.adminUp ? 'failed' : s.hung ? 'stalled' : 'healthy';
      views.push(view(id, 'switch', s.spec.label ?? id, undefined, status, fields));
    }
    for (const b of this.bonds.values()) {
      const fields = b.fields();
      // vNIC → member pinning for endpoints attached to this bond (view-field contract).
      // Unpinned vNICs (balance-tcp, or an SLB bucket not used yet) are omitted.
      const pinning: Record<string, string> = {};
      for (const [eid, e] of this.endpoints) {
        if (e.spec.attach.kind === 'bond' && e.spec.attach.id === b.id) {
          const m = b.viewPin(e.spec.mac, e.spec.vlan);
          if (m !== null) pinning[eid] = m;
        }
      }
      fields.pinning = JSON.stringify(pinning);
      views.push(view(b.id, 'bond', b.label, b.owner, b.status(), fields));
    }
    return views.sort((x, y) => cmp(x.id, y.id));
  }
}

function view(
  id: string,
  kind: string,
  label: string,
  parent: string | undefined,
  status: DeviceStatus,
  fields: Record<string, ViewField>,
): DeviceView {
  return {
    id,
    kind,
    label,
    ...(parent === undefined ? {} : { parent }),
    status,
    badges: [],
    fields,
  };
}

function drop(links: readonly LinkId[], carried: readonly LinkId[], f: Fault): RouteResult {
  return {
    delivered: false,
    links,
    carried,
    dropAt: f.at,
    reason: f.reason,
    ...(f.detail === undefined ? {} : { detail: f.detail }),
    latencyMs: 0,
  };
}

function withEgress(r: RouteResult, egress: string): RouteResult {
  return { ...r, egress };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
