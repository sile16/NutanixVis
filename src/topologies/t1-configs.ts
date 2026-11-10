/**
 * The five T1 storage-network configurations the UI offers and the guided scenarios are written
 * for: two storage vSwitches without a bond, or one bonded storage vSwitch (MAC pinning or
 * Active-Active LACP) against array ports with 4 or 8 data IPs. Every configuration runs the
 * simple view: 3 nodes, test VMs on nodes 1 and 2 and a powered-off spare on node 3, each VM at
 * line rate, 70 % read (docs/research/link-congestion.md).
 */
import type { Choice } from './options';

export type T1ConfigKey = 'two-vswitches' | 'slb-4ip' | 'slb-8ip' | 'lacp-4ip' | 'lacp-8ip';

export interface T1Config {
  readonly key: T1ConfigKey;
  /** Topology menu id (`src/ui/app/catalog.ts`). */
  readonly catalogId: string;
  /** Topology menu title. */
  readonly title: string;
  readonly bond: 'none' | 'mac-pinning' | 'lacp';
  /** FlashArray data IPs: 4 (access ports, one VLAN each) or 8 (trunked, both VLANs). */
  readonly arrayIps: 4 | 8;
  readonly options: Readonly<Record<string, Choice>>;
}

const SIMPLE = {
  'node-count': 3,
  'vm-layout': 'two-plus-spare',
  'vm-load-gbps': 'line-rate',
  'read-pct': 70,
} as const;

/**
 * One storage vSwitch (vs1 = eth2 + eth3 bonded) and two storage VLANs, one CVM storage interface
 * and IP per VLAN (DEPLOY-GUIDE "Creating an Internal Interface"). The node ports and the ISL
 * trunk both storage VLANs, so either bond member reaches either VLAN.
 */
const BONDED = {
  ...SIMPLE,
  'storage-vswitch-layout': 'single-bond',
  'storage-vlans': 'two',
} as const;

/**
 * MAC pinning (OVS balance-slb). Node 2 booted with eth3 linked up first, so it came up
 * swapped: each storage interface on the switch away from its VLAN's array ports, as a node
 * often does (docs/research/ovs-bond-behavior.md S8).
 */
const SLB = { ...BONDED, 'vs1-bond-mode': 'balance-slb', 'slb-boot-placement': 'node-2-swapped' };

/** Active-Active LACP (OVS balance-tcp): needs MLAG/vPC across the two switches. */
const LACP = { ...BONDED, 'vs1-bond-mode': 'balance-tcp', mlag: true };

const ACCESS = { 'array-port-vlans': 'access' } as const;
const TRUNKED = { 'array-port-vlans': 'trunked' } as const;
const ARRAY_4 = 'array access ports, 4 data IPs';
const ARRAY_8 = 'array trunked ports, 8 data IPs';

export const T1_CONFIGS: readonly T1Config[] = [
  {
    key: 'two-vswitches',
    catalogId: 't1-ahv-flasharray',
    title: 'Two storage vSwitches (vs1, vs2), no bond · separate storage networks',
    bond: 'none',
    arrayIps: 4,
    // vs1 (eth2, fabric A) and vs2 (eth3, fabric B), one uplink each.
    options: { ...SIMPLE, 'storage-vswitch-layout': 'per-fabric' },
  },
  {
    key: 'slb-4ip',
    catalogId: 't1-bonded-slb',
    title: `One storage vSwitch (vs1), MAC pinning · ${ARRAY_4}`,
    bond: 'mac-pinning',
    arrayIps: 4,
    options: { ...SLB, ...ACCESS },
  },
  {
    key: 'slb-8ip',
    catalogId: 't1-bonded-slb-8ip',
    title: `One storage vSwitch (vs1), MAC pinning · ${ARRAY_8}`,
    bond: 'mac-pinning',
    arrayIps: 8,
    options: { ...SLB, ...TRUNKED },
  },
  {
    key: 'lacp-4ip',
    catalogId: 't1-bonded-lacp',
    title: `One storage vSwitch (vs1), Active-Active LACP · ${ARRAY_4}`,
    bond: 'lacp',
    arrayIps: 4,
    options: { ...LACP, ...ACCESS },
  },
  {
    key: 'lacp-8ip',
    catalogId: 't1-bonded-lacp-8ip',
    title: `One storage vSwitch (vs1), Active-Active LACP · ${ARRAY_8}`,
    bond: 'lacp',
    arrayIps: 8,
    options: { ...LACP, ...TRUNKED },
  },
];

export const t1Config = (key: T1ConfigKey): T1Config => {
  const c = T1_CONFIGS.find((x) => x.key === key);
  if (!c) throw new Error(`unknown T1 config ${key}`);
  return c;
};
