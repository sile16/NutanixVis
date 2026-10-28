/**
 * T2: Nutanix HCI on AHV (SPEC §6.5 "T2 default"). 4 nodes, FT1/RF2, 2 × 25 GbE per node,
 * active-backup on vs0, two ToRs with an ISL. RF3 variant defaults to 5 nodes.
 *
 * Sources: "Nutanix Bible — AOS: Data Resilience" (RF/FT minimums, block awareness);
 * "AHV Administration Guide" 11.2, Table 9 "Bond Types".
 */
import { hciHostPlan, hciSwitchVlans, vs0BondOption } from './hci-parts';
import { computeLayout, type HostBoxSpec } from './layout';
import { option, optionSpecs, type ParamsOf, resolveParams } from './options';
import {
  buildHost,
  type DeviceInput,
  type LinkInput,
  lacpRateOption,
  mlagOption,
  nodeCountOption,
  switchPair,
  VLANS,
  vs0ActiveMemberOption,
} from './parts';
import { defineTopology, type Topology } from './schema';

export const T2_ID = 't2-hci-ahv';

export const t2Options = {
  nodeCount: nodeCountOption('node-count', 'HCI nodes', 4),
  // FT1 = data RF2; FT2 = data RF3 and needs ≥5 nodes (Nutanix Bible, Data Resilience).
  replicationFactor: option('replication-factor', 'Replication factor', [2, 3], 2),
  // Block awareness needs ≥3 blocks, and with X = nodes in the largest block the others must
  // hold ≥2X (FT1) / ≥4X (FT2) (Nutanix Bible, Data Resilience). per-node: every node its own
  // block. shared-chassis: 4 nodes per block (multi-node chassis). three-blocks: round-robin
  // over 3 blocks — met for 3 or 6 nodes, NOT met for 4 (2+1+1).
  blockLayout: option(
    'block-layout',
    'Block layout',
    ['per-node', 'shared-chassis', 'three-blocks'],
    'per-node',
  ),
  backplane: option(
    'backplane-segmentation',
    'Backplane network segmentation',
    [false, true],
    false,
  ),
  vs0BondMode: vs0BondOption(),
  vs0ActiveMember: vs0ActiveMemberOption(),
  lacpRate: lacpRateOption(),
  mlag: mlagOption(),
} as const;

export type T2Params = ParamsOf<typeof t2Options>;

export function blockFor(layout: T2Params['blockLayout'], n: number): string {
  if (layout === 'per-node') return `block-${n}`;
  if (layout === 'shared-chassis') return `block-${Math.ceil(n / 4)}`;
  return `block-${((n - 1) % 3) + 1}`;
}

export function buildT2(params: Partial<T2Params> = {}): Topology {
  const withRfDefault: Partial<T2Params> =
    params.replicationFactor === 3 && params.nodeCount === undefined
      ? { ...params, nodeCount: 5 }
      : params;
  const p = resolveParams(t2Options, withRfDefault);
  if (p.replicationFactor === 3 && p.nodeCount < 5) {
    throw new Error('RF3 (FT2) needs at least 5 nodes (Nutanix Bible, Data Resilience)');
  }

  const devices: DeviceInput[] = [];
  const links: LinkInput[] = [];
  const hostBoxes: HostBoxSpec[] = [];
  for (let n = 1; n <= p.nodeCount; n++) {
    const block = blockFor(p.blockLayout, n);
    const host = buildHost(
      hciHostPlan({
        n,
        role: 'hci',
        label: `Node ${n}`,
        block,
        bondMode: p.vs0BondMode,
        lacpRate: p.lacpRate,
        backplane: p.backplane,
        vs0ActiveMember: p.vs0ActiveMember,
      }),
    );
    devices.push(...host.devices);
    links.push(...host.links);
    hostBoxes.push(host.layout);
  }
  const vlans = hciSwitchVlans(p.backplane);
  const sw = switchPair({ vlansA: vlans, vlansB: vlans, mtu: 9216, mlag: p.mlag });

  return defineTopology({
    id: T2_ID,
    title: 'Nutanix HCI on AHV',
    family: 't2',
    description:
      `${p.nodeCount}-node HCI cluster, RF${p.replicationFactor}, 2 × 25 GbE per node ` +
      '(one NIC to each ToR), CVM and local NVMe/SSD on every node.',
    vlans: [...(p.backplane ? [VLANS.backplane] : []), VLANS.mgmt, VLANS.vm],
    devices: [...devices, ...sw.devices],
    links: [...links, ...sw.links],
    options: optionSpecs(t2Options, p),
    layout: computeLayout({ hosts: hostBoxes, switches: ['sw-a', 'sw-b'] }),
  });
}
