import { ioChainOf } from '../../domain/steps';
import { defineScenario } from '../define';
import {
  allPathsLive,
  alwaysFrom,
  atCtx,
  baseInvariants,
  by,
  cvm,
  device,
  isRunning,
  neverSeen,
  snapshotAt,
  T0,
  t1Steady,
  vm,
  vms,
} from '../helpers';
import { cvmId, nodeId, T1, vmId } from '../ids';
import { stepOfStage, stepsOf, tickOfStage } from '../steps';
import { failbackDoneS, HADES_RECOVER, P } from '../timers';

const VM = vmId(1, 1);
const CVM = cvmId(1);
const RESTORE_AT = T0 + 180;
const END = by(HADES_RECOVER + failbackDoneS(4) + P.redirector.nopIntervalS, RESTORE_AT) + 5;

/**
 * Steps view of "both storage NICs down on one node" (AHV compute, external FlashArray over
 * NVMe/TCP). Ordinal steps, not durations: the VM's IO stalls (step 1), Hades puts the node in
 * maintenance mode (2), the services stop and Stargate exits and the AHV redirector sends the
 * vDisks to remote CVMs (3), IO resumes on a remote CVM (4); after the NICs return the node
 * recovers and the sessions fail back much later, with no interruption.
 */
export default defineScenario({
  id: 't1-32-steps-both-storage-nics-down',
  title: 'T1 steps: both storage NICs of one node go down (stall, maintenance, redirect, failback)',
  topology: T1.topology,
  durationS: END,
  timeline: [
    { at: T0, action: { kind: 'fail', target: T1.storageNicA(1) }, note: 'Node 1 eth2 fails.' },
    { at: T0, action: { kind: 'fail', target: T1.storageNicB(1) }, note: 'Node 1 eth3 fails.' },
    { at: RESTORE_AT, action: { kind: 'recover', target: T1.storageNicA(1) } },
    { at: RESTORE_AT, action: { kind: 'recover', target: T1.storageNicB(1) } },
  ],
  expect: [
    ...t1Steady(),
    atCtx(
      END,
      'steps: stall 1, maintenance 2, services stop and redirect 3, IO resumes 4',
      (_s, ctx) => {
        const st = stepsOf(ctx, VM);
        return (
          stepOfStage(st, 'stall') === 1 &&
          stepOfStage(st, 'all-paths-lost') === 1 &&
          stepOfStage(st, 'maintenance') === 2 &&
          stepOfStage(st, 'services-stopped') === 3 &&
          stepOfStage(st, 'redirected') === 3 &&
          st.resumeStep === 4 &&
          st.stalledSteps === 4 &&
          st.cells.length === 4 &&
          st.impact === 'redirected'
        );
      },
    ),
    atCtx(END, 'the stages happen in this order', (_s, ctx) => {
      const st = stepsOf(ctx, VM);
      const t = (stage: string) => tickOfStage(st, stage) ?? Number.NaN;
      return (
        t('stall') <= t('all-paths-lost') &&
        t('all-paths-lost') < t('maintenance') &&
        t('maintenance') < t('services-stopped') &&
        t('services-stopped') <= t('redirected') &&
        t('redirected') < t('resumed')
      );
    }),
    atCtx(END, 'step 1: the VM is stalled on its own CVM, still served by it', (_s, ctx) => {
      const t = tickOfStage(stepsOf(ctx, VM), 'all-paths-lost') ?? -1;
      const v = vm(snapshotAt(ctx, t), VM);
      return v.state === 'io-stalled' && v.ownerCvm === CVM;
    }),
    atCtx(END, 'step 2: maintenance mode, the local Stargate has not exited yet', (_s, ctx) => {
      const t = tickOfStage(stepsOf(ctx, VM), 'maintenance') ?? -1;
      const s = snapshotAt(ctx, t);
      return device(s, CVM).fields.hades === 'maintenance' && vm(s, VM).state === 'io-stalled';
    }),
    atCtx(END, 'step 3: Stargate has exited and the vDisks are sent to remote CVMs', (_s, ctx) => {
      const t = tickOfStage(stepsOf(ctx, VM), 'services-stopped') ?? -1;
      const s = snapshotAt(ctx, t);
      return device(s, CVM).fields.stargate === 'down';
    }),
    atCtx(END, 'step 4: IO resumes on a remote CVM, the path drawn through it', (_s, ctx) => {
      const t = tickOfStage(stepsOf(ctx, VM), 'resumed') ?? -1;
      const s = snapshotAt(ctx, t);
      const v = vm(s, VM);
      const chain = ioChainOf(device(s, VM));
      return (
        isRunning(v) &&
        v.ownerCvm !== null &&
        v.ownerCvm !== CVM &&
        chain?.remote === true &&
        chain.hops.some((h) => h.role === 'cvm' && h.ids[0] === v.ownerCvm)
      );
    }),
    atCtx(END, 'recovery follows the interruption and never stalls the VM', (_s, ctx) => {
      const st = stepsOf(ctx, VM);
      const exit = stepOfStage(st, 'maintenance-exited');
      const up = stepOfStage(st, 'services-restarted');
      const back = stepOfStage(st, 'failed-back');
      if (exit === null || up === null || back === null || st.resumeStep === null) return false;
      const resumeAt = tickOfStage(st, 'resumed') ?? 0;
      const stalledAfter = ctx.history.some(
        (h) => h.simTime > resumeAt + 2 && vm(h, VM).state === 'io-stalled',
      );
      return st.resumeStep < exit && exit < up && up < back && !stalledAfter;
    }),
    alwaysFrom(RESTORE_AT + 1, 'the VMs of the other nodes never stall in the recovery', (s) =>
      vms(s)
        .filter((v) => !v.id.startsWith(`${nodeId(1)}.`))
        .every(isRunning),
    ),
    atCtx(END, 'after the failback the VM is served locally again, all paths live', (s) => {
      return allPathsLive(cvm(s, 1)) && vm(s, VM).ownerCvm === CVM;
    }),
    neverSeen(END, 'ha.vm.restarted'),
    ...baseInvariants(),
  ],
  narrative:
    "Node 1 loses both storage NICs. The VM's IO stalls on its own CVM (step 1), Hades puts the node in maintenance mode (step 2), the node's services stop and its Stargate exits, so the AHV redirector sends each vDisk to a remote CVM (step 3), and IO resumes there (step 4). Once the NICs return the node leaves maintenance and its services restart; the VM stays on the remote CVM and fails back much later, without any interruption.",
  cite: ['ntnx-cmdref-aos-7.6', 'ntnx-bible-8c', 'ntnx-bible-5b', 'everpure-nutanix-nci-cfg'],
  status: 'active',
});
