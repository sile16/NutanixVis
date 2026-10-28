/**
 * Engine-level network input (SPEC §5.3). Generic L2 building blocks: NICs, VLAN-aware switches,
 * links, bonds, host-internal bridges and IP endpoints. The topology → engine adapter produces
 * this; nothing here is vendor-specific.
 *
 * Ids share one namespace across NICs, switches, bonds and bridges, because each may also be
 * the id of a `Device` (and an action target). Links and endpoints have their own namespaces.
 */
import type { DeviceId, EndpointId, LinkId, PortId } from '../types';

/** OVS bond modes as exposed by AHV virtual switches (SPEC §5.3 table). */
export type BondMode = 'active-backup' | 'balance-slb' | 'balance-tcp' | 'no-bond';
export const BOND_MODES: readonly BondMode[] = [
  'active-backup',
  'balance-slb',
  'balance-tcp',
  'no-bond',
];

export type LacpRate = 'fast' | 'slow';

export type FlowControl = 'off' | 'global-pause' | 'pfc';

export interface NicSpec {
  readonly id: string;
  /** Device the NIC belongs to (e.g. a host); the NIC goes down with it. */
  readonly owner?: DeviceId;
  readonly label?: string;
  /** Default 1500. */
  readonly mtu?: number;
}

export interface SwitchSpec {
  readonly id: string;
  readonly label?: string;
  /** VLANs this switch carries. */
  readonly vlans: readonly number[];
  /** Default 9216. */
  readonly mtu?: number;
  /** Switches sharing an MLAG domain look like one LACP partner to a host bond. */
  readonly mlagDomain?: string;
  /** Ethernet flow control. Carried as an attribute only; effects are not modeled yet. */
  readonly flowControl?: FlowControl;
}

/** NIC↔switch, switch↔switch (ISL) or NIC↔NIC (direct attach). */
export interface LinkSpec {
  readonly id: LinkId;
  readonly a: string;
  readonly b: string;
  /** Port names for the view. Defaults: `p0` on a NIC, `p<n>` (1-based, by link id) on a switch. */
  readonly aPort?: PortId;
  readonly bPort?: PortId;
  /** Default: the smaller MTU of the two ends. */
  readonly mtu?: number;
  /** Illustrative only (SPEC §5.3 "Latency"); never drives timing. Default 0. */
  readonly latencyMs?: number;
  /** VLANs allowed on this link (switch-port pruning, strict A/B). Absent = all. */
  readonly allowedVlans?: readonly number[];
}

/** An uplink group on a host virtual switch (AHV `vs0`, `vs1`, …). */
export interface BondSpec {
  readonly id: string;
  readonly owner?: DeviceId;
  readonly label?: string;
  readonly mode: BondMode;
  /** Active member NIC ids, in priority order (active-backup picks the first live one). */
  readonly uplinks: readonly string[];
  /** Cabled NICs that `vswitch.set-uplinks` may choose from. Default: `uplinks`. */
  readonly members?: readonly string[];
  /**
   * VLAN-aware member choice for `balance-slb` and `active-backup` (default `true`): only use
   * members whose link and partner switch carry the frame's VLAN. `false` = plain OVS.
   */
  readonly slbVlanAware?: boolean;
  /** LACP rate, used only in `balance-tcp`. Default `fast`. */
  readonly lacpRate?: LacpRate;
  /**
   * Active-backup member to start on, as set with `ovs-appctl bond/set-active-slave`. It is
   * preferred whenever the bond must pick a new active member (start, failover, mode change)
   * and it is usable. There is no failback to it while another member is active. Default: the
   * first live uplink in `uplinks` order.
   */
  readonly initialActive?: string;
  /**
   * Bonds sharing a group (e.g. the virtual switch name `vs1` on every host) change mode and
   * LACP rate together: mixed bond modes on one virtual switch are not supported (SPEC §5.5).
   */
  readonly group?: string;
}

/** A host-internal bridge with no uplinks (AHV `virbr0`: hypervisor/VM ↔ local CVM). */
export interface BridgeSpec {
  readonly id: string;
  readonly owner?: DeviceId;
  readonly label?: string;
}

export interface EndpointAttach {
  readonly kind: 'nic' | 'bond' | 'bridge';
  readonly id: string;
}

/** An IP interface on one VLAN, owned by a device. Messages go endpoint to endpoint. */
export interface EndpointSpec {
  readonly id: EndpointId;
  readonly owner: DeviceId;
  readonly vlan: number;
  readonly ip: string;
  readonly mac: string;
  /** Default 1500. `large` messages need every hop to carry this MTU. */
  readonly mtu?: number;
  readonly attach: EndpointAttach;
}

/** Bond timing knobs. The adapter passes the active profile's cited values. */
export interface NetworkConfig {
  /** Hung-member detection with LACP fast rate. */
  readonly lacpFastDetectS: number;
  /** Hung-member detection with LACP slow rate. */
  readonly lacpSlowDetectS: number;
  /** balance-slb / balance-tcp hash-bucket rebalance interval. */
  readonly slbRebalanceIntervalS: number;
  /**
   * `lacp-fallback-ab` on balance-tcp bonds. A member whose LACP times out is detached while
   * another member is still negotiated. Only when no member is negotiated does the bond run
   * active-backup over every member with carrier. Off: the bond goes down instead.
   */
  readonly lacpFallbackAb: boolean;
}

/** Placeholder defaults for engine tests; real runs pass profile values (SPEC §5.3). */
export const DEFAULT_NETWORK_CONFIG: NetworkConfig = {
  lacpFastDetectS: 3,
  lacpSlowDetectS: 90,
  slbRebalanceIntervalS: 10,
  lacpFallbackAb: true,
};

export interface NetworkSpec {
  readonly nics?: readonly NicSpec[];
  readonly switches?: readonly SwitchSpec[];
  readonly links?: readonly LinkSpec[];
  readonly bonds?: readonly BondSpec[];
  readonly bridges?: readonly BridgeSpec[];
  readonly endpoints?: readonly EndpointSpec[];
  readonly config?: Partial<NetworkConfig>;
}

export class NetworkError extends Error {
  override readonly name = 'NetworkError';
}

function checkVlan(where: string, vlan: number): void {
  if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) {
    throw new NetworkError(`${where}: VLAN ${vlan} out of range 1..4094`);
  }
}

/** Structural validation; throws `NetworkError` on the first problem. */
export function validateNetworkSpec(spec: NetworkSpec): void {
  const kinds = new Map<string, string>();
  const claim = (id: string, kind: string) => {
    const prev = kinds.get(id);
    if (prev) throw new NetworkError(`duplicate network id '${id}' (${prev} and ${kind})`);
    kinds.set(id, kind);
  };
  for (const n of spec.nics ?? []) claim(n.id, 'nic');
  for (const s of spec.switches ?? []) {
    claim(s.id, 'switch');
    for (const v of s.vlans) checkVlan(`switch ${s.id}`, v);
  }
  for (const b of spec.bonds ?? []) claim(b.id, 'bond');
  for (const b of spec.bridges ?? []) claim(b.id, 'bridge');

  const linkIds = new Set<string>();
  const nicLinks = new Map<string, string>();
  for (const l of spec.links ?? []) {
    if (linkIds.has(l.id)) throw new NetworkError(`duplicate link id '${l.id}'`);
    linkIds.add(l.id);
    for (const end of [l.a, l.b]) {
      const k = kinds.get(end);
      if (k !== 'nic' && k !== 'switch') {
        throw new NetworkError(`link ${l.id}: end '${end}' is not a NIC or switch`);
      }
      if (k === 'nic') {
        const other = nicLinks.get(end);
        if (other) throw new NetworkError(`NIC ${end} is cabled twice (${other}, ${l.id})`);
        nicLinks.set(end, l.id);
      }
    }
    if (l.a === l.b) throw new NetworkError(`link ${l.id}: both ends are '${l.a}'`);
    for (const v of l.allowedVlans ?? []) checkVlan(`link ${l.id}`, v);
  }

  const bonded = new Map<string, string>();
  for (const b of spec.bonds ?? []) {
    const members = b.members ?? b.uplinks;
    for (const m of members) {
      if (kinds.get(m) !== 'nic') throw new NetworkError(`bond ${b.id}: '${m}' is not a NIC`);
      const other = bonded.get(m);
      if (other) throw new NetworkError(`NIC ${m} is in two bonds (${other}, ${b.id})`);
      bonded.set(m, b.id);
    }
    for (const u of b.uplinks) {
      if (!members.includes(u))
        throw new NetworkError(`bond ${b.id}: uplink '${u}' is not a member`);
    }
    if (b.initialActive !== undefined && !members.includes(b.initialActive)) {
      throw new NetworkError(`bond ${b.id}: initial active '${b.initialActive}' is not a member`);
    }
    if (new Set(b.uplinks).size !== b.uplinks.length) {
      throw new NetworkError(`bond ${b.id}: duplicate uplinks`);
    }
  }

  const epIds = new Set<string>();
  for (const e of spec.endpoints ?? []) {
    if (epIds.has(e.id)) throw new NetworkError(`duplicate endpoint id '${e.id}'`);
    epIds.add(e.id);
    checkVlan(`endpoint ${e.id}`, e.vlan);
    if (kinds.get(e.attach.id) !== e.attach.kind) {
      throw new NetworkError(`endpoint ${e.id}: no ${e.attach.kind} '${e.attach.id}'`);
    }
  }
}
