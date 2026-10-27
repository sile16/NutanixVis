import { defineScenario } from '../define';
import {
  allCvms,
  allPathsLive,
  allVms,
  always,
  at,
  atCtx,
  baseInvariants,
  by,
  droppedThisTick,
  eventSeen,
  neverSeen,
  T0,
} from '../helpers';
import { T1 } from '../ids';
import { P } from '../timers';

const GUEST = P.guest.linuxScsiTimeoutS;
const END = by(GUEST, 0) + 10;

export default defineScenario({
  id: 't1-12-mtu-mismatch',
  title: 'T1 misconfiguration: hosts and array at MTU 9000, switches at 1500',
  topology: T1.topology,
  options: { mtu: '1500-mismatch' },
  durationS: END,
  timeline: [],
  expect: [
    always(
      'NVMe paths stay up: keep-alives are small frames',
      (s) => s.simTime < T0 || allCvms(s, allPathsLive),
    ),
    at(T0 + 5, 'large frames are being dropped for MTU', (s) => droppedThisTick(s, 'mtu') > 0),
    atCtx(T0 + 5, 'the mismatch is reported', (_s, ctx) => eventSeen(ctx, 'net.mtu.mismatch')),
    at(T0 + 10, 'large IO never completes: every VM has commands outstanding since start-up', (s) =>
      allVms(s, (v) => v.ioPendingS >= T0),
    ),
    atCtx(END, 'guests hit their SCSI timeout', (_s, ctx) => eventSeen(ctx, 'vm.io.guest-timeout')),
    neverSeen(END, 'nvme.path.lost'),
    ...baseInvariants(),
  ],
  narrative:
    'The switches are left at MTU 1500 while the hosts and array use jumbo frames. Keep-alives and other small frames get through, so every NVMe path looks healthy, but large IO frames are dropped, so small IO completes while large IO never does. Guests eventually hit their 60 s SCSI timeout with no path failure to point at, which makes this misconfiguration hard to spot.',
  cite: ['everpure-nutanix-net-bp', 'ntnx-ncp-everpure-deploy-7.6', 'ntnx-ahv-admin-11.2'],
  status: 'todo',
});
