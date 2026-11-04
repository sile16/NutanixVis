import { defineScenario } from '../define';
import {
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
  SLACK,
  T0,
  t1Steady,
  vmsOfNode,
  vswitch,
} from '../helpers';
import { T1 } from '../ids';
import { PATH_LOSS_WORST } from '../timers';

const END = by(PATH_LOSS_WORST) + 30;

export default defineScenario({
  id: 't1-01-storage-nic',
  title: 'T1: one vs1 storage NIC fails',
  topology: T1.topology,
  durationS: END,
  timeline: [
    {
      at: T0,
      action: { kind: 'fail', target: T1.storageNicA(1) },
      note: 'Node 1 eth2 (vs1 member to Switch A) fails.',
    },
  ],
  expect: [
    ...t1Steady(),
    at(T0, 'the VLAN-A vNIC starts on eth2 (Switch A)', (s) => {
      return vswitch(s, T1.storageVs(1)).pinning[T1.segA(1)] === T1.storageNicA(1);
    }),
    atCtx(by(0), 'vs1 on node 1 moves its vNICs to eth3 on carrier loss', (s, ctx) => {
      const vs = vswitch(s, T1.storageVs(1));
      return (
        vs.activeMembers === 1 &&
        vs.pinning[T1.segA(1)] === T1.storageNicB(1) &&
        vs.pinning[T1.segB(1)] === T1.storageNicB(1) &&
        eventSeen(ctx, 'net.bond.failover', { device: T1.storageVs(1) })
      );
    }),
    alwaysFrom(T0, 'VMs keep running (latency outliers only)', (s) => allVms(s, isRunning)),
    alwaysFrom(T0, 'node 1 CVM never loses an NVMe path', (s) => allPathsLive(cvm(s, 1))),
    neverSeen(END, 'nvme.path.lost'),
    alwaysFrom(T0, 'node 1 VM IO blip is at most a couple of ticks', (s) =>
      vmsOfNode(s, 1).every((v) => v.ioPendingS <= SLACK),
    ),
    ...baseInvariants(),
  ],
  narrative:
    'Node 1 loses one vs1 uplink. The MAC-pinning bond moves both CVM storage vNICs to eth3 on carrier loss. Both storage VLANs are trunked on Switch B and the ISL, so the TCP connections survive and NVMe never notices. VM IO sees at most a brief blip.',
  cite: ['ntnx-ahv-admin-11.2', 'everpure-nutanix-net-bp', 'ntnx-ncp-everpure-deploy-7.6'],
  status: 'active',
});
