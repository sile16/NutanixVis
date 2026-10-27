/**
 * Topology → engine network adapter (SPEC §13.2 stream I). Maps declarative topology devices onto
 * the engine's generic L2 primitives. Vendor behavior stays in `domain/`; this is plumbing only.
 */
import type {
  BondSpec,
  BridgeSpec,
  EndpointSpec,
  LinkSpec,
  NetworkSpec,
  NicSpec,
  SwitchSpec,
} from '../engine/network/spec';
import type { DeviceSpec, Topology } from '../topologies/schema';

type Of<K extends DeviceSpec['kind']> = Extract<DeviceSpec, { kind: K }>;

/** Bond timing knobs, taken from the active profile's `bond` group. */
export interface BondTiming {
  readonly lacpFastDetectS: number;
  readonly lacpSlowDetectS: number;
  readonly slbRebalanceIntervalS: number;
}

/** AHV's host-internal bridge between hypervisor/VMs and the local CVM (Nutanix Bible 5a). */
export const VIRBR0 = 'virbr0';
/** Internal bridges carry no tagged traffic; any valid VLAN id works since nothing else attaches. */
const INTERNAL_VLAN = 1;
const INTERNAL_MTU = 9000;

export function bridgeId(host: string): string {
  return `${host}.${VIRBR0}`;
}
/** Hypervisor-side endpoint on virbr0 (the iSCSI redirector's address). */
export function hostInternalEndpoint(host: string): string {
  return `${host}.${VIRBR0}.host`;
}
/** CVM-side endpoint on virbr0 (the local Stargate's internal address). */
export function cvmInternalEndpoint(cvm: string): string {
  return `${cvm}.${VIRBR0}`;
}

/** Stable, locally administered MAC derived from an id (FNV-1a), so runs are deterministic. */
export function macFor(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const b = [
    0x02,
    (h >>> 24) & 0xff,
    (h >>> 16) & 0xff,
    (h >>> 8) & 0xff,
    h & 0xff,
    id.length & 0xff,
  ];
  return b.map((x) => x.toString(16).padStart(2, '0')).join(':');
}

export function topologyToNetwork(t: Topology, timing: BondTiming): NetworkSpec {
  const byId = new Map(t.devices.map((d) => [d.id, d]));
  const of = <K extends DeviceSpec['kind']>(kind: K): Of<K>[] =>
    t.devices.filter((d): d is Of<K> => d.kind === kind);

  const nics: NicSpec[] = of('nic').map((n) => ({
    id: n.id,
    ...(n.parent ? { owner: n.parent } : {}),
    label: n.label,
    mtu: n.mtu,
  }));

  const switches: SwitchSpec[] = of('switch').map((s) => ({
    id: s.id,
    label: s.label,
    vlans: s.vlans,
    mtu: s.mtu,
    flowControl: s.flowControl,
    ...(s.mlagDomain ? { mlagDomain: s.mlagDomain } : {}),
  }));

  const links: LinkSpec[] = t.links.map((l) => ({
    id: l.id,
    a: l.a,
    b: l.b,
    latencyMs: l.latencyMs,
    ...(l.mtu !== undefined ? { mtu: l.mtu } : {}),
    ...(l.allowedVlans ? { allowedVlans: l.allowedVlans } : {}),
  }));

  // A vswitch is a bond; `group` = vswitch name so mode/LACP changes apply cluster-wide (SPEC §5.5).
  const vswitches = of('vswitch');
  const bonds: BondSpec[] = vswitches.map((v) => ({
    id: v.id,
    ...(v.parent ? { owner: v.parent } : {}),
    label: v.name,
    mode: v.bondMode,
    uplinks: v.uplinks,
    members: v.members ?? v.uplinks,
    ...(v.lacpRate ? { lacpRate: v.lacpRate } : {}),
    group: v.name,
  }));
  const vswitchMtu = new Map(vswitches.map((v) => [v.id, v.mtu]));

  const endpoints: EndpointSpec[] = [];
  const bridges: BridgeSpec[] = [];

  // virbr0 on every host that has a CVM or VMs: VM↔local-CVM IO never touches uplinks.
  for (const host of of('ahv-host')) {
    const children = t.devices.filter((d) => d.parent === host.id);
    const cvm = children.find((d) => d.kind === 'cvm');
    const hasVms = children.some((d) => d.kind === 'vm');
    if (!cvm && !hasVms) continue;
    const br = bridgeId(host.id);
    bridges.push({ id: br, owner: host.id, label: VIRBR0 });
    endpoints.push({
      id: hostInternalEndpoint(host.id),
      owner: host.id,
      vlan: INTERNAL_VLAN,
      ip: '192.168.5.1',
      mac: macFor(hostInternalEndpoint(host.id)),
      mtu: INTERNAL_MTU,
      attach: { kind: 'bridge', id: br },
    });
    if (cvm) {
      endpoints.push({
        id: cvmInternalEndpoint(cvm.id),
        owner: cvm.id,
        vlan: INTERNAL_VLAN,
        ip: '192.168.5.2',
        mac: macFor(cvmInternalEndpoint(cvm.id)),
        mtu: INTERNAL_MTU,
        attach: { kind: 'bridge', id: br },
      });
    }
  }

  for (const i of [...of('cvm-interface'), ...of('host-interface')]) {
    const owner = i.parent ?? i.vswitch;
    endpoints.push({
      id: i.id,
      owner,
      vlan: i.vlan,
      ip: i.ip,
      mac: macFor(i.id),
      mtu: vswitchMtu.get(i.vswitch) ?? 1500,
      attach: { kind: 'bond', id: i.vswitch },
    });
  }

  for (const i of of('fa-interface')) {
    const nic = byId.get(i.nic);
    // Fixed interfaces live and die with their controller (the NIC's parent); a floating VIP is
    // owned by the array and re-homed to the primary's NIC by the FlashArray domain model.
    const owner = i.floating ? (i.parent ?? 'fa') : (nic?.parent ?? i.parent ?? i.nic);
    endpoints.push({
      id: i.id,
      owner,
      vlan: i.vlan,
      ip: i.ip,
      mac: macFor(i.id),
      mtu: nic?.kind === 'nic' ? nic.mtu : 1500,
      attach: { kind: 'nic', id: i.nic },
    });
  }

  return {
    nics,
    switches,
    links,
    bonds,
    bridges,
    endpoints,
    config: {
      lacpFastDetectS: timing.lacpFastDetectS,
      lacpSlowDetectS: timing.lacpSlowDetectS,
      slbRebalanceIntervalS: timing.slbRebalanceIntervalS,
    },
  };
}
