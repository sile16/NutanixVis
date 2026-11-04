import { defineScenario } from '../define';
import {
  alwaysFrom,
  atCtx,
  baseInvariants,
  isRunning,
  neverSeen,
  snapshotAt,
  T0,
  t1Steady,
  vm,
  vmsOfNode,
  vswitch,
} from '../helpers';
import { T1, vmId } from '../ids';
import { stepsOf } from '../steps';
import { P } from '../timers';

const VM = vmId(1, 1);
const RESTORE_AT = T0 + 60;
/** Long after the restore: several rebalance cycles with nothing to move. */
const END = RESTORE_AT + 12 * P.bond.slbRebalanceIntervalS;

export default defineScenario({
  id: 't1-34-steps-bond-does-not-fail-back',
  title: 'T1 steps: a MAC-pinning bond does not fail back to the restored NIC',
  topology: T1.topology,
  options: {
    'node-count': 3,
    'vm-layout': 'two',
    'vs1-bond-mode': 'balance-slb',
    'storage-vlans': 'single',
  },
  durationS: END,
  timeline: [
    { at: T0, action: { kind: 'fail', target: T1.storageNicA(1) }, note: 'Node 1 eth2 fails.' },
    {
      at: RESTORE_AT,
      action: { kind: 'recover', target: T1.storageNicA(1) },
      note: 'eth2 returns.',
    },
  ],
  expect: [
    ...t1Steady(),
    atCtx(
      END,
      'no interruption at any point (0 steps), before or after the NIC returns',
      (_s, ctx) => {
        const st = stepsOf(ctx, VM);
        return st.stalledSteps === 0 && st.impact === 'none';
      },
    ),
    atCtx(END, 'the vNIC is pinned to the surviving NIC while eth2 is down', (_s, ctx) =>
      Object.values(vswitch(snapshotAt(ctx, RESTORE_AT - 1), T1.storageVs(1)).pinning).every(
        (m) => m === T1.storageNicB(1),
      ),
    ),
    atCtx(END, 'eth2 is back in service but takes no load: the pin never moves back', (s) => {
      const vs = vswitch(s, T1.storageVs(1));
      return (
        vs.activeMembers === 2 &&
        Object.values(vs.pinning).every((m) => m === T1.storageNicB(1)) &&
        vm(s, VM).ioUplinks.every((u) => u === T1.storageNicB(1))
      );
    }),
    alwaysFrom(T0, 'the VMs keep running throughout', (s) => vmsOfNode(s, 1).every(isRunning)),
    neverSeen(END, 'nvme.path.lost'),
    ...baseInvariants(),
  ],
  narrative:
    'A MAC-pinning bond moves the storage vNIC to the surviving NIC when one fails, without any interruption. When the failed NIC returns it rejoins the bond but the vNIC stays where it is: with a single pinned source there is nothing to rebalance, so there is no failback and the restored NIC stays idle.',
  cite: ['ntnx-ahv-admin-11.2', 'ovs-bonding', 'ntnx-community-slb-rebalance'],
  status: 'active',
});
