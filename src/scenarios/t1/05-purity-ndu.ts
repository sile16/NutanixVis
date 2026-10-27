import { defineScenario } from '../define';
import {
  allCvms,
  allPathsLive,
  allRunningAt,
  allVms,
  always,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  eventsInOrder,
  fa,
  faController,
  isRunning,
  isStalled,
  neverSeen,
  SLACK,
  T0,
  t1Steady,
} from '../helpers';
import { CT0, CT1, FA, T1 } from '../ids';
import { P, PATH_LOSS_WORST } from '../timers';

const PAUSE = P.flasharray.plannedFailoverPauseS;
/** Controller reboot length is not in the profile (no public figure); allow a long run. */
const END = 1200;

export default defineScenario({
  id: 't1-05-purity-ndu',
  title: 'T1: Purity non-disruptive upgrade',
  topology: T1.topology,
  durationS: END,
  timeline: [{ at: T0, action: { kind: 'fa.ndu', target: FA }, note: 'Start a Purity NDU.' }],
  expect: [
    ...t1Steady(),
    atCtx(END, 'secondary reboots, giveback, then the old primary reboots', (_s, ctx) =>
      eventsInOrder(ctx, [
        { code: 'fa.ndu.start', device: FA },
        { code: 'fa.controller.rebooting', device: CT1 },
        { code: 'fa.controller.online', device: CT1 },
        { code: 'fa.giveback', device: CT0 },
        { code: 'fa.promotion.complete', device: CT1 },
        { code: 'fa.controller.rebooting', device: CT0 },
        { code: 'fa.controller.online', device: CT0 },
        { code: 'fa.ndu.complete', device: FA },
      ]),
    ),
    always(
      'the planned failover pause stays within its bound',
      (s) => fa(s).pauseS <= PAUSE + SLACK,
    ),
    alwaysFrom(T0, 'VMs only ever run or stall briefly', (s) =>
      allVms(
        s,
        (v) =>
          (isRunning(v) || isStalled(v)) &&
          v.ioPendingS <= Math.max(PAUSE, PATH_LOSS_WORST) + SLACK,
      ),
    ),
    at(
      END,
      'CT1 ends as primary, CT0 as secondary',
      (s) => faController(s, CT1).role === 'primary' && faController(s, CT0).role === 'secondary',
    ),
    at(END, 'every CVM has all paths back', (s) => allCvms(s, allPathsLive)),
    allRunningAt(END),
    neverSeen(END, 'vm.io.guest-timeout'),
    ...baseInvariants(),
  ],
  narrative:
    "A Purity upgrade reboots the secondary controller first; its Ethernet ports disappear while it reboots, so each CVM temporarily loses that controller's paths. Once it is back, the primary gives back and the upgraded controller promotes, with an IO pause of at most 15 s. Then the old primary reboots and returns as secondary.",
  cite: ['everpure-ha-planned', 'everpure-upgrade', 'everpure-npiv', 'everpure-ana-faq'],
  status: 'active',
});
