/**
 * What the external-storage domain needs from the declarative topology (SPEC §6.5): array,
 * controllers, interfaces, CVM storage/mgmt endpoints and switch settings. Read once at build time;
 * endpoint ids are the topology device ids (src/loader/network.ts).
 */
import type { DeviceId, EndpointId } from '../../engine/types';
import type { DeviceSpec, Topology } from '../../topologies/schema';
import type { MultipathPolicy, Profile } from '../versions/profile';

type Of<K extends DeviceSpec['kind']> = Extract<DeviceSpec, { kind: K }>;

export interface FaInterfaceFact {
  readonly id: EndpointId;
  readonly label: string;
  /** Topology parent (the port NIC, or the array for a floating VIP). */
  readonly parent: string;
  readonly nic: string;
  readonly controller: DeviceId | null;
  readonly vlan: number;
  readonly ip: string;
  readonly service: Of<'fa-interface'>['service'];
  readonly floating: boolean;
}

export interface FaControllerFact {
  readonly id: DeviceId;
  readonly label: string;
  readonly slot: 'ct0' | 'ct1';
  readonly initialRole: 'primary' | 'secondary';
  /** Port NIC carrying this controller's own mgmt interface (target of the VIP on failover). */
  readonly mgmtNic: string | null;
  /** Non-floating interfaces on this controller's ports. */
  readonly interfaces: readonly EndpointId[];
}

export interface FaFacts {
  readonly array: { readonly id: DeviceId; readonly label: string; readonly model: string };
  readonly controllers: readonly FaControllerFact[];
  readonly interfaces: readonly FaInterfaceFact[];
  /** Floating mgmt VIP (`fa.vir0`), if any. */
  readonly vip: EndpointId | null;
  readonly cvms: readonly DeviceId[];
  readonly storageEndpoints: ReadonlyMap<DeviceId, readonly EndpointId[]>;
  /** VLAN of every CVM interface. */
  readonly cvmIfaceVlan: ReadonlyMap<EndpointId, number>;
  readonly mgmtEndpoint: ReadonlyMap<DeviceId, EndpointId>;
  readonly cvmOfHost: ReadonlyMap<DeviceId, DeviceId>;
  readonly hostOfVm: ReadonlyMap<DeviceId, DeviceId>;
  readonly vms: readonly DeviceId[];
  /** NIC → its cable (link id). */
  readonly linkOfNic: ReadonlyMap<string, string>;
  readonly switches: readonly { readonly id: string; readonly flowControl: string }[];
  readonly multipathPolicy: MultipathPolicy;
}

const byId = (a: { readonly id: string }, b: { readonly id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** `multipath-policy` option value (SPEC §6.4b), else the profile default. */
function policyOf(t: Topology, profile: Profile): MultipathPolicy {
  const opt = t.options.find((o) => o.id === 'multipath-policy');
  const v = opt?.value ?? opt?.default;
  return v === 'active-active' || v === 'active-passive'
    ? v
    : profile.externalStorage.multipathPolicy.value;
}

export function readFacts(t: Topology, profile: Profile): FaFacts {
  const of = <K extends DeviceSpec['kind']>(kind: K): Of<K>[] =>
    t.devices.filter((d): d is Of<K> => d.kind === kind).sort(byId);
  const devices = new Map(t.devices.map((d) => [d.id, d] as const));

  const arr = of('fa-array')[0];
  if (!arr) throw new Error(`topology ${t.id} has no fa-array`);

  const interfaces: FaInterfaceFact[] = of('fa-interface').map((i) => {
    const nic = devices.get(i.nic);
    const controller = nic?.kind === 'nic' && nic.parent !== undefined ? nic.parent : null;
    return {
      id: i.id,
      label: i.label,
      parent: i.parent ?? arr.id,
      nic: i.nic,
      controller: i.floating ? null : controller,
      vlan: i.vlan,
      ip: i.ip,
      service: i.service,
      floating: i.floating,
    };
  });

  const controllers: FaControllerFact[] = of('fa-controller').map((c) => {
    const mine = interfaces.filter((i) => i.controller === c.id);
    return {
      id: c.id,
      label: c.label,
      slot: c.slot,
      initialRole: c.initialRole,
      mgmtNic: mine.find((i) => i.service === 'mgmt')?.nic ?? null,
      interfaces: mine.map((i) => i.id),
    };
  });

  const cvms = of('cvm').map((c) => c.id);
  const ifaces = of('cvm-interface');
  const storageEndpoints = new Map(
    cvms.map(
      (c) =>
        [
          c,
          ifaces.filter((i) => i.parent === c && i.service === 'external-storage').map((i) => i.id),
        ] as const,
    ),
  );
  const mgmtEndpoint = new Map<DeviceId, EndpointId>();
  for (const i of ifaces) {
    if (i.service === 'mgmt' && i.parent !== undefined && !mgmtEndpoint.has(i.parent)) {
      mgmtEndpoint.set(i.parent, i.id);
    }
  }
  const cvmOfHost = new Map<DeviceId, DeviceId>();
  for (const c of of('cvm')) if (c.parent !== undefined) cvmOfHost.set(c.parent, c.id);
  const hostOfVm = new Map<DeviceId, DeviceId>();
  for (const v of of('vm')) if (v.parent !== undefined) hostOfVm.set(v.id, v.parent);

  const linkOfNic = new Map<string, string>();
  for (const l of t.links) {
    linkOfNic.set(l.a, l.id);
    linkOfNic.set(l.b, l.id);
  }

  return {
    array: { id: arr.id, label: arr.label, model: arr.model },
    controllers,
    interfaces,
    vip: interfaces.find((i) => i.floating && i.service === 'mgmt')?.id ?? null,
    cvms,
    storageEndpoints,
    cvmIfaceVlan: new Map(ifaces.map((i) => [i.id, i.vlan] as const)),
    mgmtEndpoint,
    cvmOfHost,
    hostOfVm,
    vms: of('vm').map((v) => v.id),
    linkOfNic,
    switches: of('switch').map((s) => ({ id: s.id, flowControl: s.flowControl })),
    multipathPolicy: policyOf(t, profile),
  };
}

/** NVMe/TCP target interfaces on `vlan` (one NVMe path per CVM storage vNIC on the same VLAN). */
export function nvmeTargetsOn(facts: FaFacts, vlan: number): FaInterfaceFact[] {
  return facts.interfaces.filter((i) => i.service === 'nvme-tcp' && i.vlan === vlan);
}
