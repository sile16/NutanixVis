/**
 * Building blocks shared by the topology builders: VLAN plan, IP plan, hosts, the switch pair
 * and the FlashArray. Ids follow the shared conventions: `node-<n>.eth<k>`, `node-<n>.cvm.<seg>`,
 * `fa.ct0.eth10.v10`, links `l-<a>--<b>`, ISL `l-sw-a--sw-b`.
 */
import type { z } from 'zod';
import type { FaBoxSpec, HostBoxSpec } from './layout';
import { option } from './options';
import {
  type BondMode,
  BondModeSchema,
  type DeviceSpecSchema,
  type LinkSpecSchema,
  type VlanSchema,
} from './schema';

export type DeviceInput = z.input<typeof DeviceSpecSchema>;
export type LinkInput = z.input<typeof LinkSpecSchema>;
export type VlanInput = z.input<typeof VlanSchema>;
export type SwitchId = 'sw-a' | 'sw-b';
export type HostRole = 'hci' | 'compute-only' | 'storage-only' | 'external-storage-compute';
export type LacpRate = 'fast' | 'slow';

export const VLAN = { storageA: 10, storageB: 20, backplane: 30, mgmt: 100, vm: 200 } as const;

export const VLANS = {
  storageA: { id: VLAN.storageA, name: 'storage-a', purpose: 'storage' },
  storageB: { id: VLAN.storageB, name: 'storage-b', purpose: 'storage' },
  backplane: { id: VLAN.backplane, name: 'backplane', purpose: 'backplane' },
  mgmt: { id: VLAN.mgmt, name: 'mgmt', purpose: 'mgmt' },
  vm: { id: VLAN.vm, name: 'vm', purpose: 'vm' },
} as const satisfies Record<string, VlanInput>;

/** Illustrative IP plan: `10.0.<vlan>.<host>`. CVMs use .1x, the array .1xx. */
export const ip = (vlan: number, host: number) => `10.0.${vlan}.${host}`;
export const linkId = (a: string, b: string) => `l-${a}--${b}`;
export const ISL_ID = linkId('sw-a', 'sw-b');

export const BOND_MODES = BondModeSchema.options;

/** Shared bond knobs (AHV Admin Guide 11.2, Table 9 "Bond Types"). All runtime (SPEC §5.5). */
export const lacpRateOption = () =>
  // Default "Speed—Fast (1s)" per AHV Admin Guide 11.2 Table 9.
  option('lacp-rate', 'LACP rate', ['fast', 'slow'], 'fast', true);
export const mlagOption = () =>
  // LACP across two switches needs MLAG/vPC; MAC pinning does not (AHV Admin Guide 11.2 Table 9).
  option('mlag', 'MLAG / vPC between switches', [false, true], false, true);
export const nodeCountOption = (id: string, label: string, def: 3 | 4) =>
  option(id, label, [3, 4, 5, 6, 7, 8], def);

/**
 * Effective uplinks for a bond mode. "No Uplink Bond" allows 0 or 1 uplinks; every other mode
 * needs ≥2 (AHV Admin Guide 11.2 Table 9). With no-bond the first nominal NIC stays the uplink;
 * the others stay cabled but are not vswitch members.
 */
export function bondUplinks(mode: BondMode, nominal: readonly string[]): string[] {
  return mode === 'no-bond' ? nominal.slice(0, 1) : [...nominal];
}

export interface NicPlan {
  eth: number;
  speedGbps: number;
  mtu: number;
  to: SwitchId;
}
export interface VSwitchPlan {
  name: 'vs0' | 'vs1';
  bondMode: BondMode;
  lacpRate: LacpRate;
  mtu: number;
  /** Nominal member NICs (eth numbers); layout groups by these regardless of bond mode. */
  nics: readonly number[];
}
export interface CvmIfacePlan {
  segment: string;
  vswitch: 'vs0' | 'vs1';
  vlan: number;
  service: 'mgmt' | 'external-storage' | 'backplane';
}
export interface DiskPlan {
  media: 'nvme' | 'ssd' | 'hdd';
  capacityTiB: number;
}
export interface HostPlan {
  n: number;
  role: HostRole;
  label: string;
  block?: string;
  nics: readonly NicPlan[];
  vswitches: readonly VSwitchPlan[];
  /** Absent on compute-only hosts (SPEC §6.3a). */
  cvm?: readonly CvmIfacePlan[];
  vmCount: number;
  disks: readonly DiskPlan[];
}

const MEDIA_LABEL = { nvme: 'NVMe', ssd: 'SSD', hdd: 'HDD' } as const;

export interface Part {
  devices: DeviceInput[];
  links: LinkInput[];
}

export function buildHost(p: HostPlan): Part & { layout: HostBoxSpec } {
  const host = `node-${p.n}`;
  const nicId = (eth: number) => `${host}.eth${eth}`;
  const devices: DeviceInput[] = [
    {
      id: host,
      label: p.label,
      kind: 'ahv-host',
      role: p.role,
      ...(p.block ? { block: p.block } : {}),
    },
  ];
  const links: LinkInput[] = [];
  for (const nic of p.nics) {
    const id = nicId(nic.eth);
    devices.push({
      id,
      label: `eth${nic.eth}`,
      kind: 'nic',
      parent: host,
      speedGbps: nic.speedGbps,
      mtu: nic.mtu,
    });
    links.push({ id: linkId(id, nic.to), a: id, b: nic.to });
  }
  for (const vs of p.vswitches) {
    devices.push({
      id: `${host}.${vs.name}`,
      label: vs.name,
      kind: 'vswitch',
      parent: host,
      name: vs.name,
      bondMode: vs.bondMode,
      uplinks: bondUplinks(vs.bondMode, vs.nics.map(nicId)),
      // lacpRate only applies to LACP (balance-tcp) bonds.
      ...(vs.bondMode === 'balance-tcp' ? { lacpRate: vs.lacpRate } : {}),
      mtu: vs.mtu,
    });
  }
  const cvmId = `${host}.cvm`;
  if (p.cvm) {
    devices.push({ id: cvmId, label: `CVM ${p.n}`, kind: 'cvm', parent: host });
    for (const i of p.cvm) {
      devices.push({
        id: `${cvmId}.${i.segment}`,
        label: i.segment,
        kind: 'cvm-interface',
        parent: cvmId,
        vswitch: `${host}.${i.vswitch}`,
        vlan: i.vlan,
        ip: ip(i.vlan, 10 + p.n),
        service: i.service,
      });
    }
  }
  const vms = Array.from({ length: p.vmCount }, (_, i) => `${host}.vm-${i + 1}`);
  vms.forEach((id, i) => {
    devices.push({ id, label: `VM ${p.n}-${i + 1}`, kind: 'vm', parent: host });
  });
  const disks: string[] = [];
  p.disks.forEach((d, i) => {
    const id = `${host}.disk-${i + 1}`;
    disks.push(id);
    devices.push({
      id,
      label: `${MEDIA_LABEL[d.media]} ${i + 1}`,
      kind: 'disk',
      parent: host,
      media: d.media,
      capacityTiB: d.capacityTiB,
    });
  });
  return {
    devices,
    links,
    layout: {
      id: host,
      vms,
      ...(p.cvm ? { cvm: { id: cvmId, ifaces: p.cvm.map((i) => `${cvmId}.${i.segment}`) } } : {}),
      disks,
      groups: p.vswitches.map((vs) => ({
        vswitch: `${host}.${vs.name}`,
        nics: vs.nics.map(nicId),
      })),
    },
  };
}

/**
 * Two ToR switches joined by an ISL. Everpure: two switches, every node and controller connected
 * to both; fabric MTU 9216 ("Network Configuration for NCP with FlashArray").
 */
export function switchPair(p: {
  vlansA: readonly number[];
  vlansB: readonly number[];
  mtu: number;
  mlag: boolean;
}): Part {
  const sw = (id: SwitchId, label: string, vlans: readonly number[]): DeviceInput => ({
    id,
    label,
    kind: 'switch',
    vlans: [...vlans].sort((a, b) => a - b),
    mtu: p.mtu,
    ...(p.mlag ? { mlagDomain: 'mlag-1' } : {}),
  });
  return {
    devices: [sw('sw-a', 'Switch A', p.vlansA), sw('sw-b', 'Switch B', p.vlansB)],
    links: [{ id: ISL_ID, a: 'sw-a', b: 'sw-b', kind: 'isl' }],
  };
}

export interface FaPortPlan {
  name: string;
  /** Switch for [ct0, ct1]. */
  to: readonly [SwitchId, SwitchId];
  speedGbps: number;
  mtu: number;
  vlans: readonly number[];
  service: 'nvme-tcp' | 'mgmt';
}

/**
 * FlashArray with two controllers and identical port plans. Each IP is an `fa-interface` child
 * of its port. `fa.vir0` is the management VIP that follows the primary controller
 * (Deployment Guide 7.6, Tables 3 and 10); it is attached to ct0's mgmt port at build time.
 */
export function flashArray(p: { model: string; ports: readonly FaPortPlan[] }): Part & {
  layout: FaBoxSpec;
} {
  const devices: DeviceInput[] = [
    { id: 'fa', label: `FlashArray${p.model}`, kind: 'fa-array', model: p.model },
  ];
  const links: LinkInput[] = [];
  const nextHost = new Map<number, number>();
  const alloc = (vlan: number) => {
    const h = nextHost.get(vlan) ?? 101;
    nextHost.set(vlan, h + 1);
    return ip(vlan, h);
  };
  const mgmtPort = p.ports.find((port) => port.service === 'mgmt');
  if (mgmtPort) {
    devices.push({
      id: 'fa.vir0',
      label: 'vir0 (mgmt VIP)',
      kind: 'fa-interface',
      parent: 'fa',
      nic: `fa.ct0.${mgmtPort.name}`,
      vlan: VLAN.mgmt,
      ip: ip(VLAN.mgmt, 100),
      service: 'mgmt',
    });
  }
  const controllers: FaBoxSpec['controllers'][number][] = [];
  (['ct0', 'ct1'] as const).forEach((slot, ci) => {
    const ct = `fa.${slot}`;
    devices.push({
      id: ct,
      label: slot.toUpperCase(),
      kind: 'fa-controller',
      parent: 'fa',
      slot,
      initialRole: ci === 0 ? 'primary' : 'secondary',
    });
    const ports: { id: string; ifaces: string[] }[] = [];
    for (const port of p.ports) {
      const nic = `${ct}.${port.name}`;
      devices.push({
        id: nic,
        label: port.name,
        kind: 'nic',
        parent: ct,
        speedGbps: port.speedGbps,
        mtu: port.mtu,
      });
      const to = ci === 0 ? port.to[0] : port.to[1];
      links.push({ id: linkId(nic, to), a: nic, b: to });
      const ifaces: string[] = [];
      for (const vlan of port.vlans) {
        const id = `${nic}.v${vlan}`;
        ifaces.push(id);
        devices.push({
          id,
          label: port.service === 'mgmt' ? 'mgmt' : `VLAN ${vlan}`,
          kind: 'fa-interface',
          parent: nic,
          nic,
          vlan,
          ip: alloc(vlan),
          service: port.service,
        });
      }
      ports.push({ id: nic, ifaces });
    }
    controllers.push({ id: ct, ports });
  });
  return {
    devices,
    links,
    layout: { id: 'fa', ...(mgmtPort ? { vip: 'fa.vir0' } : {}), controllers },
  };
}
