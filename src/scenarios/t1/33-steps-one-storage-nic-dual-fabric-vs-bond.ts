import { ioChainOf } from '../../domain/steps';
import { defineScenario, type ScenarioDef } from '../define';
import {
  alwaysFrom,
  atCtx,
  baseInvariants,
  by,
  device,
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
import { stepOfStage, stepsOf, tickOfStage } from '../steps';
import { PATH_LOSS_WORST } from '../timers';

const VM = vmId(1, 1);
const RESTORE_AT = T0 + 90;
const END = by(PATH_LOSS_WORST, RESTORE_AT) + 30;

/** One storage NIC of node 1 fails, then returns. */
const timeline = [
  { at: T0, action: { kind: 'fail', target: T1.storageNicA(1) }, note: 'Node 1 eth2 fails.' },
  { at: RESTORE_AT, action: { kind: 'recover', target: T1.storageNicA(1) } },
] as const;

/**
 * Two isolated fabrics, no bond (a lost NIC strands its fabric): multipath abandons the lost
 * paths and retries on the surviving fabric. A short interruption, 2 steps.
 */
function dualFabric(): ScenarioDef {
  return defineScenario({
    id: 't1-33-steps-one-nic-dual-fabric',
    title:
      'T1 steps: one storage NIC down, two storage vSwitches vs1 and vs2, no bond (multipath, short stall)',
    topology: T1.topology,
    options: {
      'node-count': 3,
      'vm-layout': 'two',
      'storage-vswitch-layout': 'per-fabric',
      'vlan-placement': 'strict-ab',
    },
    durationS: END,
    timeline,
    expect: [
      ...t1Steady(),
      atCtx(
        END,
        'steps: a stall, then the lost path is abandoned and the IO retried on the other fabric',
        (_s, ctx) => {
          const st = stepsOf(ctx, VM);
          return (
            stepOfStage(st, 'stall') === 1 &&
            stepOfStage(st, 'path-rerouted') !== null &&
            st.resumeStep !== null &&
            st.stalledSteps >= 1 &&
            st.impact === 'brief'
          );
        },
      ),
      atCtx(
        END,
        'the stall ends when the commands are retried on the surviving fabric',
        (_s, ctx) => {
          const st = stepsOf(ctx, VM);
          const lost = tickOfStage(st, 'path-rerouted') ?? Number.NaN;
          const back = tickOfStage(st, 'resumed') ?? Number.NaN;
          const s = snapshotAt(ctx, back);
          const chain = ioChainOf(device(s, VM));
          return (
            lost <= back &&
            vm(s, VM).ownerCvm === `node-1.cvm` &&
            chain !== null &&
            !chain.remote &&
            chain.selector === 'queue-depth'
          );
        },
      ),
      atCtx(
        END,
        'the failed fabric is used again after the NIC returns, without a new stall',
        (s, ctx) => {
          const st = stepsOf(ctx, VM);
          return (
            (stepOfStage(st, 'path-restored') ?? 0) > (st.resumeStep ?? Number.POSITIVE_INFINITY) &&
            vm(s, VM).ioUplinks.length === 2
          );
        },
      ),
      alwaysFrom(T0, 'no service stops and no redirect: the CVM keeps serving', (s) =>
        vmsOfNode(s, 1).every((v) => v.ownerCvm === 'node-1.cvm'),
      ),
      neverSeen(END, 'hades.maintenance.enter'),
      neverSeen(END, 'redirector.redirect'),
      ...baseInvariants(),
    ],
    narrative:
      'Two storage vSwitches (vs1 on eth2, vs2 on eth3, no bond): when one NIC fails, the commands queued on its paths wait (step 1) until the paths are declared lost and multipath retries them on the other fabric (step 2). Stargate stays up and nothing is redirected, so this is a short interruption. When the NIC returns its paths reconnect without a new stall.',
    cite: [
      'spdk-nvme-multipath',
      'nvme-base-spec-2.1',
      'everpure-nutanix-301-deck',
      'everpure-nutanix-net-bp',
    ],
    status: 'active',
  });
}

/**
 * One virtual switch with an active/active MAC-pinning bond (balance-slb), one storage vNIC:
 * the bond re-pins the vNIC to the surviving NIC on carrier loss, so the VM sees no interruption.
 */
function bond(): ScenarioDef {
  return defineScenario({
    id: 't1-33-steps-one-nic-bond',
    title:
      'T1 steps: one storage NIC down, one storage vSwitch vs1 with a MAC-pinning bond (no interruption)',
    topology: T1.topology,
    options: {
      'node-count': 3,
      'vm-layout': 'two',
      'vlan-placement': 'tagged-both',
      'isl-storage-vlans': 'allowed',
      'vs1-bond-mode': 'balance-slb',
      'storage-vlans': 'single',
    },
    durationS: END,
    timeline,
    expect: [
      ...t1Steady(),
      atCtx(END, 'steps: no interruption (0 steps)', (_s, ctx) => {
        const st = stepsOf(ctx, VM);
        return st.stalledSteps === 0 && st.cells.length === 0 && st.impact === 'none';
      }),
      alwaysFrom(T0, 'the VM keeps running and no NVMe path is lost', (s) =>
        vmsOfNode(s, 1).every(isRunning),
      ),
      atCtx(END, 'the bond re-pinned the vNIC to the surviving NIC', (_s, ctx) => {
        const s = snapshotAt(ctx, RESTORE_AT - 1);
        return Object.values(vswitch(s, T1.storageVs(1)).pinning).every(
          (m) => m === T1.storageNicB(1),
        );
      }),
      neverSeen(END, 'nvme.path.lost'),
      ...baseInvariants(),
    ],
    narrative:
      'With both storage NICs in one MAC-pinning bond, a NIC failure only moves the storage vNIC to the other NIC. The VM sees no interruption (0 steps) and Stargate keeps all its paths. Compare the unbonded dual-fabric layout, where the same failure costs a short stall.',
    cite: ['ntnx-ahv-admin-11.2', 'ovs-bonding', 'everpure-nutanix-net-bp'],
    status: 'active',
  });
}

export default [dualFabric(), bond()];
