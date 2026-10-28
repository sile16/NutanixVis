/**
 * Static facts the Nutanix domain derives once from the declarative topology: roles, CVMs, VMs,
 * endpoints, block placement and the configured fault tolerance. Behavior code reads these, never
 * the raw topology, so any number of vswitches / CVM storage interfaces is handled generically.
 */
import { cvmInternalEndpoint, hostInternalEndpoint } from '../../loader/network';
import type { DeviceSpec, Topology } from '../../topologies/schema';

type Of<K extends DeviceSpec['kind']> = Extract<DeviceSpec, { kind: K }>;
export type HostRole = Of<'ahv-host'>['role'];

export interface HostFacts {
  readonly id: string;
  readonly label: string;
  readonly role: HostRole;
  readonly block: string | null;
  readonly cvm: string | null;
  readonly vms: readonly string[];
  /** Host mgmt IP (`host-interface`, service mgmt); null if the topology has none. */
  readonly mgmtEndpoint: string | null;
  /** virbr0 endpoint (exists when the host has a CVM or VMs; see loader). */
  readonly internalEndpoint: string | null;
  /** Physical NIC ids and the links cabling them. */
  readonly nics: readonly string[];
  readonly nicLinks: readonly string[];
}

export interface CvmFacts {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  /** CVM mgmt (external) IP: what hosts' redirectors and HA polls use. */
  readonly mgmtEndpoint: string;
  /** Inter-CVM endpoint: backplane if segmented, else mgmt (ZK, replication, rebuild). */
  readonly dataEndpoint: string;
  readonly storageEndpoints: readonly string[];
  readonly internalEndpoint: string;
}

export interface VmFacts {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly vdisks: readonly string[];
  readonly pathLossForceShutdownS: number | null;
}

export interface Facts {
  readonly topologyId: string;
  readonly family: Topology['family'];
  /** T1 / T1-lab: VM data and cluster-service volumes live on the external array. */
  readonly externalStorage: boolean;
  readonly hosts: readonly HostFacts[];
  readonly cvms: readonly CvmFacts[];
  readonly vms: readonly VmFacts[];
  /**
   * T1 `hades-maintenance-on-storage-error` option: true/false when the topology sets it, null to
   * use the profile default (`hades.maintenanceOnStorageError`).
   */
  readonly hadesMaintenance: boolean | null;
  /** Data replication factor (T2/T3 `replication-factor`); null for external storage. */
  readonly replicationFactor: number | null;
  /** NIC id → owning host id. */
  readonly nicOwner: ReadonlyMap<string, string>;
  /** Link id → the host NIC at one of its ends (host uplink cables only). */
  readonly linkHostNic: ReadonlyMap<string, string>;
  /** CVM ids in block-aware ring order (round-robin over blocks). */
  readonly ringOrder: readonly string[];
  host(id: string): HostFacts | undefined;
  cvm(id: string): CvmFacts | undefined;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Natural order for `node-<n>` ids, so node-10 sorts after node-9. */
export function nodeOrder(a: string, b: string): number {
  const na = Number(/^node-(\d+)/.exec(a)?.[1] ?? Number.NaN);
  const nb = Number(/^node-(\d+)/.exec(b)?.[1] ?? Number.NaN);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function vdiskId(vm: string, k: number): string {
  return `${vm}.vdisk-${k}`;
}

export function buildFacts(t: Topology): Facts {
  const of = <K extends DeviceSpec['kind']>(kind: K): Of<K>[] =>
    t.devices.filter((d): d is Of<K> => d.kind === kind).sort(byId);
  const children = (id: string) => t.devices.filter((d) => d.parent === id);

  const cvmIfaces = of('cvm-interface');
  const hostIfaces = of('host-interface');
  const nicLinks = new Map<string, string>();
  for (const l of t.links) {
    nicLinks.set(l.a, l.id);
    nicLinks.set(l.b, l.id);
  }

  const cvms: CvmFacts[] = of('cvm').map((c) => {
    const ifs = cvmIfaces.filter((i) => i.parent === c.id);
    const mgmt = ifs.find((i) => i.service === 'mgmt');
    if (!mgmt) throw new Error(`${c.id}: CVM has no mgmt interface`);
    const backplane = ifs.find((i) => i.service === 'backplane');
    return {
      id: c.id,
      label: c.label,
      host: c.parent ?? '',
      mgmtEndpoint: mgmt.id,
      dataEndpoint: (backplane ?? mgmt).id,
      storageEndpoints: ifs.filter((i) => i.service === 'external-storage').map((i) => i.id),
      internalEndpoint: cvmInternalEndpoint(c.id),
    };
  });

  const nicOwner = new Map<string, string>();
  const hosts: HostFacts[] = of('ahv-host')
    .sort((a, b) => nodeOrder(a.id, b.id))
    .map((h) => {
      const kids = children(h.id);
      const cvm = kids.find((d) => d.kind === 'cvm')?.id ?? null;
      const vms = kids.filter((d) => d.kind === 'vm').map((d) => d.id);
      const nics = kids.filter((d) => d.kind === 'nic').map((d) => d.id);
      for (const n of nics) nicOwner.set(n, h.id);
      const mgmt = hostIfaces.find((i) => i.parent === h.id && i.service === 'mgmt');
      return {
        id: h.id,
        label: h.label,
        role: h.role,
        block: h.block ?? null,
        cvm,
        vms,
        mgmtEndpoint: mgmt?.id ?? null,
        internalEndpoint: cvm || vms.length ? hostInternalEndpoint(h.id) : null,
        nics,
        nicLinks: nics.flatMap((n) => {
          const l = nicLinks.get(n);
          return l === undefined ? [] : [l];
        }),
      };
    });

  const vms: VmFacts[] = of('vm').map((v) => ({
    id: v.id,
    label: v.label,
    host: v.parent ?? '',
    vdisks: Array.from({ length: v.vdisks }, (_, k) => vdiskId(v.id, k + 1)),
    pathLossForceShutdownS: v.pathLossForceShutdownS ?? null,
  }));

  const linkHostNic = new Map<string, string>();
  for (const l of t.links) {
    const nic = nicOwner.has(l.a) ? l.a : nicOwner.has(l.b) ? l.b : undefined;
    if (nic !== undefined) linkHostNic.set(l.id, nic);
  }

  const rfOpt = t.options.find((o) => o.id === 'replication-factor');
  const rfVal = rfOpt?.value ?? rfOpt?.default;
  const externalStorage = t.family === 't1' || t.family === 't1-lab';
  const hadesOpt = t.options.find((o) => o.id === 'hades-maintenance-on-storage-error');
  const hadesVal = hadesOpt?.value ?? hadesOpt?.default;

  const hostById = new Map(hosts.map((h) => [h.id, h]));
  const cvmById = new Map(cvms.map((c) => [c.id, c]));
  return {
    topologyId: t.id,
    family: t.family,
    externalStorage,
    hosts,
    cvms: [...cvms].sort((a, b) => nodeOrder(a.id, b.id)),
    vms,
    hadesMaintenance: hadesVal === 'on' ? true : hadesVal === 'off' ? false : null,
    replicationFactor: externalStorage ? null : typeof rfVal === 'number' ? rfVal : 2,
    nicOwner,
    linkHostNic,
    ringOrder: ringOrder(cvms, hostById),
    host: (id) => hostById.get(id),
    cvm: (id) => cvmById.get(id),
  };
}

/**
 * Block-aware ring order: round-robin over blocks (blocks ordered by their lowest node), so
 * consecutive ring neighbours sit in different blocks whenever the layout allows it
 * (Bible 4i "Block Fault Tolerance": no two Cassandra peers in one block).
 */
function ringOrder(cvms: readonly CvmFacts[], hosts: ReadonlyMap<string, HostFacts>): string[] {
  const sorted = [...cvms].sort((a, b) => nodeOrder(a.id, b.id));
  const blocks = new Map<string, string[]>();
  for (const c of sorted) {
    const b = hosts.get(c.host)?.block ?? c.host;
    blocks.set(b, [...(blocks.get(b) ?? []), c.id]);
  }
  const lists = [...blocks.values()];
  const out: string[] = [];
  for (let i = 0; out.length < sorted.length; i++) {
    for (const l of lists) {
      const c = l[i];
      if (c !== undefined) out.push(c);
    }
  }
  return out;
}
