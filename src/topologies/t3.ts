/**
 * T3: HCI cluster with dedicated compute-only (CO) nodes (SPEC §6.3a, §6.5 "T3 default").
 * - t3-co-so: 3 CO + 4 storage-only (SO) nodes.
 * - t3-co-hci: 2 CO + 4 HCI nodes.
 * CO nodes are numbered first (node-1…), then the CVM-bearing nodes.
 *
 * Sources: "AHV Administration Guide" 11.2, "AHV Compute-Only Node Configuration" and
 * "Adding an AHV Storage-Only Node"; Table 9 "Bond Types".
 */
import { hciHostPlan, hciSwitchVlans, vs0BondOption } from './hci-parts';
import { computeLayout, type HostBoxSpec } from './layout';
import { type OptionSpecInput, option, optionSpecs, type ParamsOf, resolveParams } from './options';
import {
  buildHost,
  type DeviceInput,
  type LinkInput,
  lacpRateOption,
  mlagOption,
  switchPair,
  VLANS,
} from './parts';
import { defineTopology, type Topology } from './schema';

export const T3_CO_SO_ID = 't3-co-so';
export const T3_CO_HCI_ID = 't3-co-hci';

const bondOptions = {
  vs0BondMode: vs0BondOption(),
  lacpRate: lacpRateOption(),
  mlag: mlagOption(),
} as const;

export const t3CoSoOptions = {
  // ≥3 schedulable nodes before the first SO node is added (AHV Admin Guide 11.2 "Adding an
  // AHV Storage-Only Node"); SO nodes are never schedulable, so CO count ≥3.
  coCount: option('co-node-count', 'Compute-only nodes', [3, 4, 5, 6, 7, 8], 3),
  storageCount: option('so-node-count', 'Storage-only nodes', [3, 4, 5, 6, 7, 8], 4),
  ...bondOptions,
} as const;

export const t3CoHciOptions = {
  // ≥2 CO nodes recommended so HA can restart CO VMs on CO nodes (community, unverified).
  coCount: option('co-node-count', 'Compute-only nodes', [1, 2, 3, 4, 5, 6, 7, 8], 2),
  storageCount: option('hci-node-count', 'HCI nodes', [3, 4, 5, 6, 7, 8], 4),
  ...bondOptions,
} as const;

export type T3CoSoParams = ParamsOf<typeof t3CoSoOptions>;
export type T3CoHciParams = ParamsOf<typeof t3CoHciOptions>;

interface T3Resolved {
  coCount: number;
  storageCount: number;
  vs0BondMode: T3CoSoParams['vs0BondMode'];
  lacpRate: T3CoSoParams['lacpRate'];
  mlag: boolean;
}

function buildT3(
  id: string,
  storageRole: 'storage-only' | 'hci',
  p: T3Resolved,
  options: OptionSpecInput[],
): Topology {
  const tag = storageRole === 'hci' ? 'HCI' : 'SO';
  const devices: DeviceInput[] = [];
  const links: LinkInput[] = [];
  const hostBoxes: HostBoxSpec[] = [];
  const total = p.coCount + p.storageCount;
  for (let n = 1; n <= total; n++) {
    const co = n <= p.coCount;
    const host = buildHost(
      hciHostPlan({
        n,
        role: co ? 'compute-only' : storageRole,
        label: `Node ${n} (${co ? 'CO' : tag})`,
        bondMode: p.vs0BondMode,
        lacpRate: p.lacpRate,
        backplane: false,
      }),
    );
    devices.push(...host.devices);
    links.push(...host.links);
    hostBoxes.push(host.layout);
  }
  const vlans = hciSwitchVlans(false);
  const sw = switchPair({ vlansA: vlans, vlansB: vlans, mtu: 9216, mlag: p.mlag });
  return defineTopology({
    id,
    title: storageRole === 'hci' ? 'HCI + compute-only nodes' : 'Compute-only + storage-only nodes',
    family: 't3',
    description:
      `${p.coCount} compute-only nodes (no CVM: storage IO crosses the bond to remote CVMs) and ` +
      `${p.storageCount} ${storageRole === 'hci' ? 'HCI' : 'storage-only (CVM + disks, no VMs)'} nodes.`,
    vlans: [VLANS.mgmt, VLANS.vm],
    devices: [...devices, ...sw.devices],
    links: [...links, ...sw.links],
    options,
    layout: computeLayout({ hosts: hostBoxes, switches: ['sw-a', 'sw-b'] }),
  });
}

export function buildT3CoSo(params: Partial<T3CoSoParams> = {}): Topology {
  const p = resolveParams(t3CoSoOptions, params);
  return buildT3(T3_CO_SO_ID, 'storage-only', p, optionSpecs(t3CoSoOptions, p));
}

export function buildT3CoHci(params: Partial<T3CoHciParams> = {}): Topology {
  const p = resolveParams(t3CoHciOptions, params);
  return buildT3(T3_CO_HCI_ID, 'hci', p, optionSpecs(t3CoHciOptions, p));
}
