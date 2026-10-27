/**
 * Static cluster facts the HCI data path needs, read from the declarative topology: which nodes
 * hold data (CVM-bearing only: HCI and storage-only, SPEC §6.3a), their disks and blocks, the
 * configured RF, and the vDisks that exist at t=0.
 */
import type { DeviceId } from '../../../engine/types';
import type { DeviceSpec, Topology } from '../../../topologies/schema';

type DiskSpec = Extract<DeviceSpec, { kind: 'disk' }>;

export interface DataNode {
  readonly cvm: DeviceId;
  readonly host: DeviceId;
  readonly block?: string;
  readonly disks: readonly DiskSpec[];
}

export interface VdiskSeed {
  readonly id: string;
  readonly vm: DeviceId;
  /** CVM whose Stargate wrote it (the first replica's node). */
  readonly home: DeviceId;
}

export interface HciLayout {
  /** Sorted by CVM id. */
  readonly nodes: readonly DataNode[];
  readonly rf: number;
  readonly vdisks: readonly VdiskSeed[];
  readonly disks: readonly DiskSpec[];
}

/** Stable vDisk id for VM `vm`'s k-th disk (1-based). Stream F should issue IO with these ids. */
export const vdiskId = (vm: DeviceId, k: number): string => `${vm}.vdisk-${k}`;

/** Default RF where a topology has no `replication-factor` option (T3 default is RF2, SPEC §6.5). */
const DEFAULT_RF = 2;

export function optionValue(t: Topology, id: string): string | number | boolean | undefined {
  const o = t.options.find((x) => x.id === id);
  return o === undefined ? undefined : (o.value ?? o.default);
}

export function readLayout(t: Topology): HciLayout {
  const byId = new Map(t.devices.map((d) => [d.id, d]));
  const cvms = t.devices
    .filter((d) => d.kind === 'cvm')
    .map((d) => d.id)
    .sort();
  const hostOf = (cvm: DeviceId): DeviceId => byId.get(cvm)?.parent ?? cvm;
  const disks = t.devices.filter((d): d is DiskSpec => d.kind === 'disk');

  const nodes: DataNode[] = cvms.map((cvm) => {
    const host = hostOf(cvm);
    const h = byId.get(host);
    const block = h?.kind === 'ahv-host' ? h.block : undefined;
    return {
      cvm,
      host,
      ...(block === undefined ? {} : { block }),
      disks: disks.filter((d) => d.parent === host).sort((a, b) => cmp(a.id, b.id)),
    };
  });
  const cvmOnHost = new Map(nodes.map((n) => [n.host, n.cvm]));

  const rfOpt = optionValue(t, 'replication-factor');
  const rf = typeof rfOpt === 'number' ? rfOpt : DEFAULT_RF;

  // vDisk home: the VM's local CVM; a compute-only VM has none, so its vDisks are spread
  // round-robin over the CVM nodes (`assumption`, SPEC §6.3a "Stargate selection").
  const vdisks: VdiskSeed[] = [];
  let rr = 0;
  const vms = t.devices
    .filter((d): d is Extract<DeviceSpec, { kind: 'vm' }> => d.kind === 'vm')
    .sort((a, b) => cmp(a.id, b.id));
  for (const vm of vms) {
    const local = vm.parent === undefined ? undefined : cvmOnHost.get(vm.parent);
    for (let k = 1; k <= vm.vdisks; k++) {
      const home = local ?? cvms[rr++ % Math.max(cvms.length, 1)];
      if (home !== undefined) vdisks.push({ id: vdiskId(vm.id, k), vm: vm.id, home });
    }
  }
  return { nodes, rf, vdisks, disks };
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
