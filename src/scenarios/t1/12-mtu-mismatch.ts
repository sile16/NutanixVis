import { defineScenario } from '../define';
import {
  allCvms,
  allPathsLive,
  allVms,
  at,
  atCtx,
  baseInvariants,
  by,
  droppedThisTick,
  eventSeen,
  eventsMatching,
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
    at(P.externalStorage.ioTimeoutS - 1, 'keep-alives are small frames: every path is up', (s) =>
      allCvms(s, allPathsLive),
    ),
    at(T0 + 5, 'large frames are being dropped for MTU', (s) => droppedThisTick(s, 'mtu') > 0),
    atCtx(T0 + 5, 'the mismatch is reported', (_s, ctx) => eventSeen(ctx, 'net.mtu.mismatch')),
    at(T0 + 10, 'large IO never completes: every VM has commands outstanding since start-up', (s) =>
      allVms(s, (v) => v.ioPendingS >= T0),
    ),
    atCtx(END, 'guests hit their SCSI timeout', (_s, ctx) => eventSeen(ctx, 'vm.io.guest-timeout')),
    atCtx(
      END,
      'no path is lost to keep-alive; the IO timeout only resets paths, which reconnect',
      (_s, ctx) =>
        eventsMatching(ctx, 'nvme.path.lost').every((e) => e.text.includes('IO timeout')) &&
        eventSeen(ctx, 'nvme.io.timeout') &&
        eventSeen(ctx, 'nvme.path.restored'),
    ),
    ...baseInvariants(),
  ],
  narrative:
    'The switches are left at MTU 1500 while the hosts and array use jumbo frames. Keep-alives and other small frames get through, so every NVMe path looks healthy, but large IO frames are dropped, so small IO completes while large IO never does. The NVMe IO timeout resets a path now and then and it reconnects at once, and guests hit their 60 s SCSI timeout with no lasting path failure to point at, which makes this misconfiguration hard to spot.',
  cite: ['everpure-nutanix-net-bp', 'ntnx-ncp-everpure-deploy-7.6', 'ntnx-ahv-admin-11.2'],
  status: 'active',
});
