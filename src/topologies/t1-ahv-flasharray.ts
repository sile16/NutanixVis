/**
 * T1: AHV compute cluster + external Everpure FlashArray over NVMe/TCP (SPEC §6.5).
 *
 * Sources:
 * - DEPLOY-GUIDE: "Nutanix Cloud Platform with Everpure FlashArray Deployment Guide" 7.6.
 * - NET: Everpure, "Network Configuration for NCP with FlashArray".
 * - AHV-ADMIN: "AHV Administration Guide" 11.2, Table 9 "Bond Types".
 */

import { vs0BondOption } from './hci-parts';
import { computeLayout } from './layout';
import { option, optionSpecs, type ParamsOf, resolveParams } from './options';
import {
  BOND_MODES,
  buildHost,
  type CvmIfacePlan,
  type DeviceInput,
  flashArray,
  HOST_MGMT,
  ISL_IDS,
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

/**
 * Line rates (illustrative sizing, per direction). 50 Gb node NICs against a 2 × 100 Gb ISL and
 * 100 Gb array ports: two nodes at line rate with every interface on the far switch come close to
 * filling the ISL, and three exceed it.
 */
export const NODE_NIC_GBPS = 50;
export const ARRAY_PORT_GBPS = 100;
export const ISL_GBPS = 200;

export const t1Options = {
  // 4 nodes tolerate N−2 simultaneous node failures (DEPLOY-GUIDE "Compute Cluster High
  // Availability"); ≥3 nodes required (DEPLOY-GUIDE limits).
  nodeCount: nodeCountOption('node-count', 'AHV nodes', 4),
  // `two`: one test VM on node 1 and one on node 2; `two-plus-spare` adds a powered-off VM on
  // node 3 to power on mid-run (the simple view the UI offers); `per-node`: two VMs on every node.
  vmLayout: option('vm-layout', 'Test VMs', ['per-node', 'two', 'two-plus-spare'], 'per-node'),
  // Throughput model (docs/research/link-congestion.md). Each running VM's offered storage load:
  // `line-rate` = no cap, the VM pushes as hard as its guest queue depth allows, so the NICs and
  // links limit it. Illustrative workload, not vendor behavior.
  vmLoadGbps: option(
    'vm-load-gbps',
    'Offered load per VM (Gb/s)',
    [10, 25, 50, 100, 'line-rate'],
    10,
  ),
  // Changed per VM at runtime with the VM action `vm.set-load`.
  readPct: option('read-pct', 'Read share of the load (%)', [70, 50, 30, 100, 0], 70),
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
  // vs0 (management, CVM-to-CVM, redirects): Active-Active LACP by default (`vs0BondOption`);
  // DEPLOY-GUIDE Table 2 specifies Active-Backup, still selectable. With Active-Backup, which
  // member is active decides who is cut off when a switch hangs with carrier up.
  vs0BondMode: vs0BondOption(),
  vs0ActiveMember: vs0ActiveMemberOption(),
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
  // still reaches the array. `off` keeps IO retrying in place (DEPLOY-GUIDE default).
  hadesMaintenance: option(
    'hades-maintenance-on-storage-error',
    'Hades maintenance mode on service-volume loss (inferred)',
    ['on', 'off'],
    'on',
  ),
  // Outstanding IOs per vDisk of the illustrative guest workload. A queue-depth-bound guest with
  // no more slots than a dead path has IO queues stalls completely on a silent path loss, even
  // under the queue-depth selector (SPEC §6.4c item 3).
  guestQueueDepth: option('guest-queue-depth', 'Guest queue depth per vDisk', [32, 8, 4, 1], 32),
  // Whole-array loss (SPEC §6.4 "T1 full array loss"): crash-and-restart lets VMs no Stargate
  // has served for redirector.initiatorSessionTimeoutS crash, and AHV powers them back on once the array is back
  // (profile default, `assumption`); stall keeps IO retrying in place (DEPLOY-GUIDE wording).
  wholeArrayLossVmBehavior: option(
    'whole-array-loss-vm-behavior',
    'VMs on whole-array loss (assumption)',
    ['crash-and-restart', 'stall'],
    'crash-and-restart',
  ),
  // single-bond: vs1 = eth2 + eth3 bonded (vs0 keeps eth0 + eth1 for management). per-fabric: two
  // storage vswitches with "No Uplink Bond" (AHV Admin Guide 11.2 Table 9), vs1 = eth2 → Switch A
  // (storage-a), vs2 = eth3 → Switch B (storage-b); NVMe multipathing alone provides redundancy.
  // NET discourages no-bond but allows it as an exception; seen in field deployments.
  storageVswitchLayout: option(
    'storage-vswitch-layout',
    'Storage vswitch layout',
    ['single-bond', 'per-fabric'],
    'single-bond',
  ),
  // `first-only`: only the first data port of each controller (eth10, Switch A side) is cabled;
  // the second (eth11) keeps its address but is not connected, by design. Each CVM then has
  // two live array paths and two portals that never answer, which is expected, not a fault.
  arrayDataPorts: option(
    'array-data-ports',
    'Array data ports cabled',
    ['all', 'first-only'],
    'all',
  ),
  // `access`: eth10 on storage VLAN A and eth11 on VLAN B, one IP per port (4 data IPs).
  // `trunked`: every data port carries both storage VLANs with one IP per VLAN (8 data IPs), so
  // each CVM storage interface has a portal on both switches (NET).
  arrayPortVlans: option(
    'array-port-vlans',
    'Array data port VLANs',
    ['access', 'trunked'],
    'access',
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
        vswitch: 'vs1',
        vlan: VLAN.storageA,
        service: 'external-storage',
      },
    ];
    if (p.storageVlans === 'two') {
      cvm.push({
        segment: 'storage-b',
        vswitch: perFabric ? 'vs2' : 'vs1',
        vlan: VLAN.storageB,
        service: 'external-storage',
      });
    }
    const storageVswitches: VSwitchPlan[] = perFabric
      ? [
          { name: 'vs1', bondMode: 'no-bond', lacpRate: p.lacpRate, mtu: jumbo, nics: [2] },
          { name: 'vs2', bondMode: 'no-bond', lacpRate: p.lacpRate, mtu: jumbo, nics: [3] },
        ]
      : [
          // vs1: NVMe/TCP data only, always bonded (DEPLOY-GUIDE Table 2).
          { name: 'vs1', bondMode: p.vs1BondMode, lacpRate: p.lacpRate, mtu: jumbo, nics: [2, 3] },
        ];
    const host = buildHost({
      n,
      role: 'external-storage-compute',
      label: `Node ${n}`,
      // vs0 (management): eth0 + eth1; storage: eth2 + eth3, one NIC of each pair to each switch.
      nics: [
        { eth: 0, speedGbps: NODE_NIC_GBPS, mtu: 1500, to: 'sw-a' },
        { eth: 1, speedGbps: NODE_NIC_GBPS, mtu: 1500, to: 'sw-b' },
        { eth: 2, speedGbps: NODE_NIC_GBPS, mtu: jumbo, to: 'sw-a' },
        { eth: 3, speedGbps: NODE_NIC_GBPS, mtu: jumbo, to: 'sw-b' },
      ],
      vswitches: [
        // vs0: mgmt, live migration, DR, apps; MTU 1500 (DEPLOY-GUIDE Table 2). LACP at the fast
        // rate Prism always sets (AHV Admin Guide 11.2); `lacp-rate` applies to vs1 only.
        {
          name: 'vs0',
          bondMode: p.vs0BondMode,
          lacpRate: 'fast',
          mtu: 1500,
          nics: [0, 1],
          initialActive: vs0InitialActive(p.vs0ActiveMember, n, 0, 1),
        },
        ...storageVswitches,
      ],
      cvm,
      vmCount: p.vmLayout === 'per-node' ? 2 : n <= 2 ? 1 : 0,
      spareVmCount: p.vmLayout === 'two-plus-spare' && n === 3 ? 1 : 0,
      vmPathLossForceShutdownS: forceShutdownS(p.pathLossForceShutdownS),
      disks: [],
      hostIfaces: [HOST_MGMT],
    });
    devices.push(...host.devices);
    links.push(...host.links);
    hostBoxes.push(host.layout);
  }

  // Where the storage VLANs live. With one bonded storage vSwitch, every node storage port is an
  // 802.1Q trunk carrying both storage VLANs, and so is the ISL: OVS pins, fails over and
  // rebalances a storage interface onto either member without checking its VLAN (OVS
  // `ofproto/bond.c`), so isolated per-switch VLANs on a bond are not a working design and are
  // not offered. Trunked array ports need the same. Only two unbonded storage vSwitches with
  // access array ports keep VLAN A on Switch A and VLAN B on Switch B, off the ISL ("single hop").
  const trunked = p.storageVswitchLayout === 'single-bond' || p.arrayPortVlans === 'trunked';
  const base = [VLAN.mgmt, VLAN.vm];
  const strict = !trunked;
  const sw = switchPair({
    vlansA: [...base, ...storage.filter((v) => !strict || v === VLAN.storageA)],
    vlansB: [...base, ...storage.filter((v) => !strict || v === VLAN.storageB)],
    mtu: fabricMtu,
    mlag: p.mlag,
    flowControl: p.flowControl,
    islSpeedGbps: ISL_GBPS,
  });

  // ct0/ct1.eth10 → Switch A, ct0/ct1.eth11 → Switch B, plus mgmt (SPEC §6.5; NET). With a
  // single storage VLAN every data port sits on that VLAN.
  const arrayTrunk = p.arrayPortVlans === 'trunked';
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
        speedGbps: ARRAY_PORT_GBPS,
        mtu: jumbo,
        vlans: arrayTrunk ? storage : [VLAN.storageA],
        service: 'nvme-tcp',
      },
      {
        name: 'eth11',
        to: ['sw-b', 'sw-b'],
        speedGbps: ARRAY_PORT_GBPS,
        mtu: jumbo,
        vlans: arrayTrunk ? storage : [storage[1] ?? VLAN.storageA],
        service: 'nvme-tcp',
        cabled: p.arrayDataPorts === 'all',
      },
    ],
  });

  return defineTopology({
    id: T1_ID,
    title: 'AHV + Everpure FlashArray (NVMe/TCP)',
    family: 't1',
    description:
      `${p.nodeCount} AHV compute nodes with an external FlashArray//X70 over NVMe/TCP. ` +
      'vs0 (management, eth0 + eth1) is separate from the storage vSwitches: one vs1 with both ' +
      'storage NICs bonded, or vs1 and vs2 with one NIC each and no bond.',
    vlans: [
      VLANS.storageA,
      ...(p.storageVlans === 'two' ? [VLANS.storageB] : []),
      VLANS.mgmt,
      VLANS.vm,
    ],
    devices: [...devices, ...sw.devices, ...fa.devices],
    links: [
      ...links,
      ...(trunked ? sw.links : pruneStorageFromIsl(sw.links, storage)),
      ...fa.links,
    ],
    options: optionSpecs(t1Options, p),
    layout: computeLayout({ hosts: hostBoxes, switches: ['sw-a', 'sw-b'], fa: fa.layout }),
  });
}

/** Prune the storage VLANs from the ISL: storage stays single-hop. */
function pruneStorageFromIsl(links: readonly LinkInput[], storage: readonly number[]): LinkInput[] {
  const keep = [VLAN.mgmt, VLAN.vm].filter((v) => !storage.includes(v));
  const isl: readonly string[] = ISL_IDS;
  return links.map((l) => (isl.includes(l.id) ? { ...l, allowedVlans: keep } : l));
}
