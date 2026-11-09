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
import { guideChecks, stepOfStage, stepsOf, tickOfStage } from '../steps';
import { PATH_LOSS_WORST } from '../timers';

const VM = vmId(1, 1);
const RESTORE_AT = T0 + 90;
const END = by(PATH_LOSS_WORST, RESTORE_AT) + 30;

/** One storage NIC of node 1 fails, then returns. */
const timeline = [
  { at: T0, action: { kind: 'fail', target: T1.storageNicA(1) }, note: 'Node 1 eth2 fails.' },
  { at: RESTORE_AT, action: { kind: 'recover', target: T1.storageNicA(1) } },
] as const;

const DUAL_GUIDE = {
  vm: VM,
  groups: [
    [
      {
        stage: 'stall',
        step: 1,
        io: 'partial',
        text: "eth2 is offline: only the commands queued on its paths are stuck (the VM shows the share); the rest of the VM's IO completes on eth3's paths.",
      },
      {
        stage: 'path-rerouted',
        step: 1,
        text: "Keep-alive declares eth2's paths lost; new IO goes to eth3's paths only.",
      },
      {
        stage: 'resumed',
        step: 2,
        text: "The stuck commands are retried on eth3's paths: all IO completes again. No service restart, no redirect.",
      },
    ],
    [
      {
        stage: 'path-restored',
        text: "eth2's paths reconnect and take IO again, without a new stall.",
      },
    ],
  ],
} as const;

const BOND_GUIDE = {
  vm: VM,
  groups: [
    [
      {
        io: 'none',
        text: 'The bond moves the storage vNIC to eth3. No IO stalls: the step counter stays at 0.',
      },
    ],
    [{ io: 'none', text: 'eth2 rejoins the bond; still no stall.' }],
  ],
} as const;

/**
 * Two isolated fabrics, no bond (a lost NIC strands its fabric): multipath abandons the lost
 * paths and retries on the surviving fabric. A short, partial interruption.
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
      ...guideChecks(DUAL_GUIDE, END),
      ...baseInvariants(),
    ],
    narrative:
      "Two storage vSwitches (vs1 on eth2, vs2 on eth3, no bond): when one NIC fails, only the commands queued on its paths stall, while the rest of the VM's IO completes on the other fabric (step 1). Once the paths are declared lost the stuck commands are retried on the other fabric and all IO completes again (step 2). Stargate stays up and nothing is redirected, so this is a short, partial interruption. When the NIC returns its paths reconnect without a new stall.",
    guide: DUAL_GUIDE,
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
      ...guideChecks(BOND_GUIDE, END),
      ...baseInvariants(),
    ],
    guide: BOND_GUIDE,
    narrative:
      'With both storage NICs in one MAC-pinning bond, a NIC failure only moves the storage vNIC to the other NIC. The VM sees no interruption (0 steps) and Stargate keeps all its paths. Compare the unbonded dual-fabric layout, where the same failure costs a short stall.',
    cite: ['ntnx-ahv-admin-11.2', 'ovs-bonding', 'everpure-nutanix-net-bp'],
    status: 'active',
  });
}

export default [dualFabric(), bond()];
