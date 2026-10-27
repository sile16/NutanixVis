import { defineScenario } from '../define';
import {
  allCvms,
  allPathsLive,
  allVms,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  eventSeen,
  fa,
  isRunning,
  T0,
  t1Steady,
} from '../helpers';
import { FA_MGMT, T1, vmId } from '../ids';

const VM = vmId(1, 1);
const RESTORE_AT = T0 + 60;
const END = RESTORE_AT + 60;

export default defineScenario({
  id: 't1-13-fa-mgmt-unreachable',
  title: 'T1: FlashArray management API unreachable',
  topology: T1.topology,
  durationS: END,
  timeline: [
    {
      at: T0,
      action: { kind: 'fa.interface.disable', target: FA_MGMT },
      note: 'The array management VIP becomes unreachable.',
    },
    // `vm.snapshot` is a proposed action kind (not yet in the shared list).
    { at: T0 + 5, action: { kind: 'vm.snapshot', target: VM }, note: 'Take a VM snapshot.' },
    { at: RESTORE_AT, action: { kind: 'fa.interface.enable', target: FA_MGMT } },
    { at: RESTORE_AT + 5, action: { kind: 'vm.snapshot', target: VM }, note: 'Retry.' },
  ],
  expect: [
    ...t1Steady(),
    at(T0 + 3, 'management API is unreachable', (s) => fa(s).mgmtApi === 'unreachable'),
    atCtx(RESTORE_AT, 'the snapshot task fails', (_s, ctx) =>
      eventSeen(ctx, 'mgmt.task.failed', { device: VM, from: T0 + 5 }),
    ),
    alwaysFrom(
      T0,
      'running IO is unaffected',
      (s) => allVms(s, isRunning) && allCvms(s, allPathsLive),
    ),
    atCtx(END, 'the retried snapshot succeeds once the API is back', (_s, ctx) =>
      eventSeen(ctx, 'mgmt.task.succeeded', { device: VM, from: RESTORE_AT + 5 }),
    ),
    ...baseInvariants(),
  ],
  narrative:
    'The FlashArray management API becomes unreachable while the data ports stay up. Provisioning and snapshot tasks fail because Nutanix drives the array through that API, but running VM IO over NVMe/TCP is unaffected. Once the API is reachable again the snapshot succeeds.',
  cite: ['ntnx-ncp-everpure-deploy-7.6', 'ntnx-bible-8c'],
  status: 'active',
});
