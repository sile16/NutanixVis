/**
 * T1-lab: the T1 domain model shaped like the test drive lab (SPEC §6.5 "T1-lab"): one NIC per
 * node, no uplink bond, mgmt + both storage segments tagged on vs0. The array exposes two VLAN
 * interfaces per data port so single array-side IPs can be disabled.
 *
 * Assumptions until the lab is surveyed (docs/research/lab-validation-plan.md): odd nodes cable
 * to Switch A and even nodes to Switch B; MTU 1500 everywhere.
 */
import { computeLayout } from './layout';
import { optionSpecs, type ParamsOf, resolveParams } from './options';
import {
  buildHost,
  type DeviceInput,
  flashArray,
  HOST_MGMT,
  type LinkInput,
  nodeCountOption,
  switchPair,
  VLAN,
  VLANS,
} from './parts';
import { defineTopology, type Topology } from './schema';
import { forceShutdownS, t1Options } from './t1-ahv-flasharray';

export const T1_LAB_ID = 't1-lab';

export const t1LabOptions = {
  nodeCount: nodeCountOption('node-count', 'AHV nodes', 3),
  // Single NIC per node: both storage VLANs must reach every node's switch, so the lab defaults to
  // tagged-both. strict-ab here demonstrates the resulting reachability gap.
  vlanPlacement: { ...t1Options.vlanPlacement, default: 'tagged-both' },
  multipathPolicy: t1Options.multipathPolicy,
  pathSelector: t1Options.pathSelector,
  pathLossForceShutdownS: t1Options.pathLossForceShutdownS,
  hadesMaintenance: t1Options.hadesMaintenance,
  guestQueueDepth: t1Options.guestQueueDepth,
  wholeArrayLossVmBehavior: t1Options.wholeArrayLossVmBehavior,
} as const;

export type T1LabParams = ParamsOf<typeof t1LabOptions>;

export function buildT1Lab(params: Partial<T1LabParams> = {}): Topology {
  const p = resolveParams(t1LabOptions, params);
  const mtu = 1500;
  const devices: DeviceInput[] = [];
  const links: LinkInput[] = [];
  const hostBoxes = [];
  for (let n = 1; n <= p.nodeCount; n++) {
    const host = buildHost({
      n,
      role: 'external-storage-compute',
      label: `Node ${n}`,
      nics: [{ eth: 0, speedGbps: 25, mtu, to: n % 2 === 1 ? 'sw-a' : 'sw-b' }],
      // "No Uplink Bond": 0 or 1 uplinks (AHV Administration Guide 11.2, Table 9).
      vswitches: [{ name: 'vs0', bondMode: 'no-bond', lacpRate: 'fast', mtu, nics: [0] }],
      cvm: [
        { segment: 'mgmt', vswitch: 'vs0', vlan: VLAN.mgmt, service: 'mgmt' },
        { segment: 'storage-a', vswitch: 'vs0', vlan: VLAN.storageA, service: 'external-storage' },
        { segment: 'storage-b', vswitch: 'vs0', vlan: VLAN.storageB, service: 'external-storage' },
      ],
      vmCount: 2,
      vmPathLossForceShutdownS: forceShutdownS(p.pathLossForceShutdownS),
      disks: [],
      hostIfaces: [HOST_MGMT],
    });
    devices.push(...host.devices);
    links.push(...host.links);
    hostBoxes.push(host.layout);
  }

  const strict = p.vlanPlacement === 'strict-ab';
  const base = [VLAN.mgmt, VLAN.vm];
  const sw = switchPair({
    vlansA: strict ? [...base, VLAN.storageA] : [...base, VLAN.storageA, VLAN.storageB],
    vlansB: strict ? [...base, VLAN.storageB] : [...base, VLAN.storageA, VLAN.storageB],
    mtu: 9216,
    mlag: false,
  });
  const both = [VLAN.storageA, VLAN.storageB];
  const fa = flashArray({
    model: '//X70',
    ports: [
      {
        name: 'eth0',
        to: ['sw-a', 'sw-b'],
        speedGbps: 1,
        mtu,
        vlans: [VLAN.mgmt],
        service: 'mgmt',
      },
      { name: 'eth10', to: ['sw-a', 'sw-a'], speedGbps: 25, mtu, vlans: both, service: 'nvme-tcp' },
      { name: 'eth11', to: ['sw-b', 'sw-b'], speedGbps: 25, mtu, vlans: both, service: 'nvme-tcp' },
    ],
  });

  return defineTopology({
    id: T1_LAB_ID,
    title: 'T1 lab mirror (single NIC, no bond)',
    family: 't1-lab',
    description:
      `${p.nodeCount} AHV nodes with one NIC each (no uplink bond) carrying mgmt and both ` +
      'storage segments; FlashArray with two data IPs per port for single-path failures.',
    vlans: [VLANS.storageA, VLANS.storageB, VLANS.mgmt, VLANS.vm],
    devices: [...devices, ...sw.devices, ...fa.devices],
    links: [...links, ...sw.links, ...fa.links],
    options: optionSpecs(t1LabOptions, p),
    layout: computeLayout({ hosts: hostBoxes, switches: ['sw-a', 'sw-b'], fa: fa.layout }),
  });
}
