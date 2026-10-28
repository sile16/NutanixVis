import { defineScenario } from '../define';
import {
  allCvms,
  allPathsLive,
  allVms,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  by,
  cvm,
  eventSeen,
  isRunning,
  neverSeen,
  onlyPathsLostTo,
  SLACK,
  T0,
  t1Steady,
  vswitch,
} from '../helpers';
import { cvmId, T1 } from '../ids';
import { KATO, PATH_LOSS_RULE, PATH_LOSS_WORST } from '../timers';

const END = by(PATH_LOSS_WORST) + 30;

export default defineScenario({
  id: 't1-16-slb-rebalance-strict-ab',
  title: 'T1 misconfiguration: MAC-pinning rebalance strands the VLAN-A vNIC (isolated A/B VLANs)',
  topology: T1.topology,
  options: { 'vlan-placement': 'strict-ab', 'vs1-bond-mode': 'balance-slb' },
  durationS: END,
  timeline: [
    {
      at: T0,
      // `vswitch.rebalance` is a proposed action: force the next SLB rebalance to move one vNIC.
      action: {
        kind: 'vswitch.rebalance',
        target: T1.storageVs(1),
        params: { vnic: T1.segA(1), member: T1.storageNicB(1) },
      },
      note: 'A load rebalance pins the VLAN-A vNIC to eth3 (Switch B).',
    },
  ],
  expect: [
    ...t1Steady(),
    at(
      T0,
      'VLAN-A vNIC starts on the Switch A uplink',
      (s) => vswitch(s, T1.storageVs(1)).pinning[T1.segA(1)] === T1.storageNicA(1),
    ),
    atCtx(
      by(0),
      'the rebalance moves it to eth3',
      (s, ctx) =>
        eventSeen(ctx, 'net.bond.rebalance', { device: T1.storageVs(1) }) &&
        vswitch(s, T1.storageVs(1)).pinning[T1.segA(1)] === T1.storageNicB(1),
    ),
    at(by(KATO), "node 1's VLAN-A paths are lost with no hardware failure", (s) =>
      onlyPathsLostTo(cvm(s, 1), T1.faIfacesA),
    ),
    at(by(KATO), 'other CVMs are unaffected', (s) =>
      allCvms(s, (c) => c.id === cvmId(1) || allPathsLive(c)),
    ),
    alwaysFrom(T0, 'VMs keep running on the VLAN-B paths', (s) => allVms(s, isRunning)),
    alwaysFrom(T0, `no command waits longer than ${PATH_LOSS_RULE}`, (s) =>
      allVms(s, (v) => v.ioPendingS <= PATH_LOSS_WORST + SLACK),
    ),
    neverSeen(END, 'net.link.down'),
    ...baseInvariants(),
  ],
  narrative:
    'MAC pinning periodically rebalances vNICs across uplinks by load, and it does not know which VLANs each switch carries. Here a rebalance moves the VLAN-A vNIC onto the uplink to Switch B, which has no VLAN 10, so its paths go silent and are lost after the keep-alive timeout even though nothing failed. IO carries on over VLAN B, but the node has quietly lost half its paths.',
  cite: ['ntnx-ahv-admin-11.2', 'everpure-nutanix-net-bp', 'ovs-bonding', 'nvme-base-spec'],
  // todo until the workload issues at least one IO per NVMe path per tick (src/domain/workload/io.ts:
  // 2 reads + 2 writes, queue depth 32): with 1 + 1 a tick's two IOs can both land on the
  // silently lost paths, so the VM reads io-stalled for that tick although IO is flowing.
  status: 'active',
});
