/**
 * T1: AHV compute cluster + external Everpure FlashArray over NVMe/TCP (SPEC §6.5).
 *
 * Sources:
 * - DEPLOY-GUIDE: "Nutanix Cloud Platform with Everpure FlashArray Deployment Guide" 7.6.
 * - NET: Everpure, "Network Configuration for NCP with FlashArray".
 * - AHV-ADMIN: "AHV Administration Guide" 11.2, Table 9 "Bond Types".
 */
import { computeLayout } from './layout';
import { option, optionSpecs, type ParamsOf, resolveParams } from './options';
import {
  BOND_MODES,
  buildHost,
  type CvmIfacePlan,
  type DeviceInput,
  flashArray,
  HOST_MGMT,
  ISL_ID,
  type LinkInput,
  lacpRateOption,
  mlagOption,
  nodeCountOption,
  switchPair,
  VLAN,
  VLANS,
  type VSwitchPlan,
  vs0ActiveMemberOption,
  vs0InitialActive,
} from './parts';
import { defineTopology, type Topology } from './schema';

/** `path-loss-force-shutdown-s` choice → per-VM schema value (`off` = retry forever). */
export function forceShutdownS(v: 'off' | 60 | 120 | 300): number | undefined {
  return v === 'off' ? undefined : v;
}

export const T1_ID = 't1-ahv-flasharray';

export const t1Options = {
  // 4 nodes tolerate N−2 simultaneous node failures (DEPLOY-GUIDE "Compute Cluster High
  // Availability"); ≥3 nodes required (DEPLOY-GUIDE limits).
  nodeCount: nodeCountOption('node-count', 'AHV nodes', 4),
  // Default MAC pinning: Everpure's recommendation (NET). LACP is Nutanix's preference when
  // available (DEPLOY-GUIDE Table 2). No-bond is discouraged by both (NET).
  vs1BondMode: option(
    'vs1-bond-mode',
    'vs1 (storage) uplink bond',
    BOND_MODES,
    'balance-slb',
    true,
  ),
  lacpRate: lacpRateOption(),
  mlag: mlagOption(),
  // vs0 is Active-Backup (DEPLOY-GUIDE Table 2); which member is active decides who is cut off
  // when a switch hangs with carrier up (SPEC §7.2 T1-20, T1-21).
  vs0ActiveMember: vs0ActiveMemberOption(),
  // Default: isolated storage VLANs (fabric A/B), the typical storage design. NET lists
  // "dedicated switches for each VLAN" as a supported option. tagged-both carries both storage
  // VLANs on both switches.
  vlanPlacement: option(
    'vlan-placement',
    'Storage VLAN placement',
    ['strict-ab', 'tagged-both'],
    'strict-ab',
    true,
  ),
  // NET: "Do not enable Priority Flow Control (PFC) or Global Pause ... not supported by
  // Everpure FlashArray in NVMe/TCP environments." Non-off values are misconfigurations.
  flowControl: option(
    'flow-control',
    'Switch flow control',
    ['off', 'global-pause', 'pfc'],
    'off',
    true,
  ),
  // NET: "at least two VLANs dedicated to NVMe/TCP data storage traffic". single = misconfig.
  storageVlans: option('storage-vlans', 'Storage VLANs', ['two', 'single'], 'two'),
  // Jumbo frames recommended end to end, fabric at 9216 (NET; DEPLOY-GUIDE range 1280–9000).
  // 1500-mismatch: hosts and array at 9000, switches left at 1500.
  mtu: option('mtu', 'Storage MTU', [9000, '1500-mismatch'], 9000, true),
  // Stargate/SPDK policy is not public: `assumption` until lab L12 (SPEC §6.4b). Touches no
  // device field; the engine reads it from the topology's options.
  multipathPolicy: option(
    'multipath-policy',
    'NVMe multipath policy (assumption)',
    ['active-active', 'active-passive'],
    'active-active',
  ),
  // How active-active picks a path per command (SPEC §6.4b/§6.4c). Stargate's selector is not
  // public; queue-depth follows Everpure's Linux guidance for FlashArray NVMe (`inferred`).
  // round-robin shows how a queue-depth-bound guest stalls completely on one silent path loss.
  pathSelector: option(
    'nvme-path-selector',
    'NVMe path selector',
    ['queue-depth', 'round-robin'],
    'queue-depth',
  ),
  // DEPLOY-GUIDE "Compute Cluster High Availability": by default a node retries IO until the
  // array responds; an optional per-VM force-shutdown timeout restarts the VM on a node with
  // array connectivity. Applied to every VM (`vm.pathLossForceShutdownS`). Values illustrative.
  pathLossForceShutdownS: option(
    'path-loss-force-shutdown-s',
    'Per-VM path-loss force-shutdown (s)',
    ['off', 60, 120, 300],
    'off',
  ),
  // Hades (profile `hades.maintenanceOnStorageError`, `inferred`): a CVM that loses its
  // service volumes goes into maintenance mode, so the redirector moves its VMs to a CVM that
  // still reaches the array. `off` keeps IO retrying in place (DEPLOY-GUIDE default) for lab L1.
  hadesMaintenance: option(
    'hades-maintenance-on-storage-error',
    'Hades maintenance mode on service-volume loss (inferred)',
    ['on', 'off'],
    'on',
  ),
  // single-bond: vs1 = eth1 + eth3 bonded (DEPLOY-GUIDE Table 2). per-fabric: two storage
  // vswitches with "No Uplink Bond" (AHV Admin Guide 11.2 Table 9), vs1a = eth1 → Switch A
  // (storage-a), vs1b = eth3 → Switch B (storage-b); NVMe multipathing alone provides redundancy.
  // NET discourages no-bond but allows it as an exception; seen in field deployments.
  storageVswitchLayout: option(
    'storage-vswitch-layout',
    'Storage vswitch layout',
    ['single-bond', 'per-fabric'],
    'single-bond',
  ),
  // Field practice keeps storage off the ISL ("single hop"); the Cisco Validated Design allows
  // it. Only matters with vlan-placement tagged-both.
  islStorageVlans: option(
    'isl-storage-vlans',
    'Storage VLANs on the ISL',
    ['pruned', 'allowed'],
    'pruned',
  ),
} as const;

export type T1Params = ParamsOf<typeof t1Options>;

export function buildT1(params: Partial<T1Params> = {}): Topology {
  const p = resolveParams(t1Options, params);
  const storage = p.storageVlans === 'two' ? [VLAN.storageA, VLAN.storageB] : [VLAN.storageA];
  const jumbo = 9000;
  const fabricMtu = p.mtu === 9000 ? 9216 : 1500;

  const devices: DeviceInput[] = [];
  const links: LinkInput[] = [];
  const hostBoxes = [];
  for (let n = 1; n <= p.nodeCount; n++) {
    const perFabric = p.storageVswitchLayout === 'per-fabric';
    const cvm: CvmIfacePlan[] = [
      { segment: 'mgmt', vswitch: 'vs0', vlan: VLAN.mgmt, service: 'mgmt' },
      // One vNIC + one IP per storage segment (DEPLOY-GUIDE "Creating an Internal Interface").
      {
        segment: 'storage-a',
        vswitch: perFabric ? 'vs1a' : 'vs1',
        vlan: VLAN.storageA,
        service: 'external-storage',
      },
    ];
    if (p.storageVlans === 'two') {
      cvm.push({
        segment: 'storage-b',
        vswitch: perFabric ? 'vs1b' : 'vs1',
        vlan: VLAN.storageB,
        service: 'external-storage',
      });
    }
    const storageVswitches: VSwitchPlan[] = perFabric
      ? [
          { name: 'vs1a', bondMode: 'no-bond', lacpRate: p.lacpRate, mtu: jumbo, nics: [1] },
          { name: 'vs1b', bondMode: 'no-bond', lacpRate: p.lacpRate, mtu: jumbo, nics: [3] },
        ]
      : [
          // vs1: NVMe/TCP data only, always bonded (DEPLOY-GUIDE Table 2).
          { name: 'vs1', bondMode: p.vs1BondMode, lacpRate: p.lacpRate, mtu: jumbo, nics: [1, 3] },
        ];
    const host = buildHost({
      n,
      role: 'external-storage-compute',
      label: `Node ${n}`,
      // vs0: eth0+eth2, vs1: eth1+eth3, one NIC of each to each switch (DEPLOY-GUIDE Table 2).
      nics: [
        { eth: 0, speedGbps: 25, mtu: 1500, to: 'sw-a' },
        { eth: 1, speedGbps: 25, mtu: jumbo, to: 'sw-a' },
        { eth: 2, speedGbps: 25, mtu: 1500, to: 'sw-b' },
        { eth: 3, speedGbps: 25, mtu: jumbo, to: 'sw-b' },
      ],
      vswitches: [
        // vs0: mgmt, live migration, DR, apps; Active/Backup, MTU 1500 (DEPLOY-GUIDE Table 2).
        {
          name: 'vs0',
          bondMode: 'active-backup',
          lacpRate: p.lacpRate,
          mtu: 1500,
          nics: [0, 2],
          initialActive: vs0InitialActive(p.vs0ActiveMember, n, 0, 2),
        },
        ...storageVswitches,
      ],
      cvm,
      vmCount: 2,
      vmPathLossForceShutdownS: forceShutdownS(p.pathLossForceShutdownS),
      disks: [],
      hostIfaces: [HOST_MGMT],
    });
    devices.push(...host.devices);
    links.push(...host.links);
    hostBoxes.push(host.layout);
  }

  const base = [VLAN.mgmt, VLAN.vm];
  const strict = p.vlanPlacement === 'strict-ab';
  const sw = switchPair({
    vlansA: [...base, ...storage.filter((v) => !strict || v === VLAN.storageA)],
    vlansB: [...base, ...storage.filter((v) => !strict || v === VLAN.storageB)],
    mtu: fabricMtu,
    mlag: p.mlag,
    flowControl: p.flowControl,
  });

  // ct0/ct1.eth10 → Switch A, ct0/ct1.eth11 → Switch B, plus mgmt (SPEC §6.5; NET). With a
  // single storage VLAN every data port sits on that VLAN.
  const fa = flashArray({
    model: '//X70',
    ports: [
      {
        name: 'eth0',
        to: ['sw-a', 'sw-b'],
        speedGbps: 1,
        mtu: 1500,
        vlans: [VLAN.mgmt],
        service: 'mgmt',
      },
      {
        name: 'eth10',
        to: ['sw-a', 'sw-a'],
        speedGbps: 25,
        mtu: jumbo,
        vlans: [VLAN.storageA],
        service: 'nvme-tcp',
      },
      {
        name: 'eth11',
        to: ['sw-b', 'sw-b'],
        speedGbps: 25,
        mtu: jumbo,
        vlans: [storage[1] ?? VLAN.storageA],
        service: 'nvme-tcp',
      },
    ],
  });

  return defineTopology({
    id: T1_ID,
    title: 'AHV + Everpure FlashArray (NVMe/TCP)',
    family: 't1',
    description:
      `${p.nodeCount} AHV compute nodes with an external FlashArray//X70 over NVMe/TCP. ` +
      'vs0 (mgmt/VM) and vs1 (storage) each bond one NIC to each switch; two storage VLANs.',
    vlans: [
      VLANS.storageA,
      ...(p.storageVlans === 'two' ? [VLANS.storageB] : []),
      VLANS.mgmt,
      VLANS.vm,
    ],
    devices: [...devices, ...sw.devices, ...fa.devices],
    links: [...links, ...islPlan(sw.links, storage, p.islStorageVlans), ...fa.links],
    options: optionSpecs(t1Options, p),
    layout: computeLayout({ hosts: hostBoxes, switches: ['sw-a', 'sw-b'], fa: fa.layout }),
  });
}

/** Prune the storage VLANs from the ISL (`isl-storage-vlans: pruned`): storage stays single-hop. */
function islPlan(
  links: readonly LinkInput[],
  storage: readonly number[],
  mode: 'pruned' | 'allowed',
): LinkInput[] {
  if (mode === 'allowed') return [...links];
  const keep = [VLAN.mgmt, VLAN.vm].filter((v) => !storage.includes(v));
  return links.map((l) => (l.id === ISL_ID ? { ...l, allowedVlans: keep } : l));
}
