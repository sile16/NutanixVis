/**
 * Shared pieces for HCI-style hosts (T2, T3): one vs0 bond of eth0 (Switch A) + eth1 (Switch B),
 * CVM on the mgmt VLAN, optional backplane segment, local disks.
 */
import { option } from './options';
import {
  BOND_MODES,
  type CvmIfacePlan,
  type DiskPlan,
  HOST_MGMT,
  type HostPlan,
  type HostRole,
  type LacpRate,
  VLAN,
  type Vs0ActiveMember,
  vs0InitialActive,
} from './parts';
import type { BondMode } from './schema';

/** Bond default active-backup on br0/vs0 (AHV Administration Guide 11.2, Table 9). Runtime. */
export const vs0BondOption = () =>
  option('vs0-bond-mode', 'vs0 uplink bond', BOND_MODES, 'active-backup', true);

/** Per-node disks: 2 NVMe + 4 SSD (illustrative capacities). */
export const HCI_DISKS: readonly DiskPlan[] = [
  { media: 'nvme', capacityTiB: 7 },
  { media: 'nvme', capacityTiB: 7 },
  { media: 'ssd', capacityTiB: 3.5 },
  { media: 'ssd', capacityTiB: 3.5 },
  { media: 'ssd', capacityTiB: 3.5 },
  { media: 'ssd', capacityTiB: 3.5 },
];

export interface HciHostParams {
  n: number;
  role: Exclude<HostRole, 'external-storage-compute'>;
  label: string;
  block?: string;
  bondMode: BondMode;
  lacpRate: LacpRate;
  /** Network segmentation: backplane on its own VLAN via the CVM's backplane vNIC. */
  backplane: boolean;
  /** vs0 active-backup starting member (`vs0-active-member`). Default `first`. */
  vs0ActiveMember?: Vs0ActiveMember;
}

export function hciHostPlan(h: HciHostParams): HostPlan {
  const hasCvm = h.role !== 'compute-only';
  const cvm: CvmIfacePlan[] = [
    { segment: 'mgmt', vswitch: 'vs0', vlan: VLAN.mgmt, service: 'mgmt' },
  ];
  if (h.backplane) {
    cvm.push({ segment: 'backplane', vswitch: 'vs0', vlan: VLAN.backplane, service: 'backplane' });
  }
  return {
    n: h.n,
    role: h.role,
    label: h.label,
    ...(h.block ? { block: h.block } : {}),
    // 2 × 25 GbE, one NIC to each ToR (SPEC §6.5 T2). MTU 1500 is the AHV default.
    nics: [
      { eth: 0, speedGbps: 25, mtu: 1500, to: 'sw-a' },
      { eth: 1, speedGbps: 25, mtu: 1500, to: 'sw-b' },
    ],
    vswitches: [
      {
        name: 'vs0',
        bondMode: h.bondMode,
        lacpRate: h.lacpRate,
        mtu: 1500,
        nics: [0, 1],
        initialActive: vs0InitialActive(h.vs0ActiveMember ?? 'first', h.n, 0, 1),
      },
    ],
    // CO: no CVM, no local storage (AHV Admin Guide 11.2 "AHV Compute-Only Node Configuration").
    // SO: AOS never schedules VMs (AHV Admin Guide 11.2 "Adding an AHV Storage-Only Node").
    ...(hasCvm ? { cvm } : {}),
    vmCount: h.role === 'storage-only' ? 0 : 2,
    disks: hasCvm ? HCI_DISKS : [],
    hostIfaces: [HOST_MGMT],
  };
}

export const hciSwitchVlans = (backplane: boolean) =>
  backplane ? [VLAN.backplane, VLAN.mgmt, VLAN.vm] : [VLAN.mgmt, VLAN.vm];
