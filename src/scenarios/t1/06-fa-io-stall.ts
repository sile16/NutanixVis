import { defineScenario } from '../define';
import {
  allRunningAt,
  allVms,
  always,
  at,
  atCtx,
  baseInvariants,
  before,
  by,
  eventSeen,
  eventsInOrder,
  fa,
  faController,
  isStalled,
  neverSeen,
  SLACK,
  T0,
  t1Steady,
} from '../helpers';
import { CT0, CT1, T1 } from '../ids';
import { P } from '../timers';

const DELAY = P.flasharray.ioDelayTimeoutS;
const RECOVERED = DELAY + P.flasharray.promotionMaxS;
const END = by(RECOVERED) + 60;

export default defineScenario({
  id: 't1-06-fa-io-stall-giveback',
  title: 'T1: FlashArray primary IO stall triggers a giveback',
  topology: T1.topology,
  durationS: END,
  timeline: [
    {
      at: T0,
      action: { kind: 'fa.io-stall', target: CT0 },
      note: 'CT0 (primary) stops completing IO without crashing.',
    },
  ],
  expect: [
    ...t1Steady(),
    at(T0 + 6, 'all VM IO is stalled array-wide', (s) =>
      allVms(s, (v) => isStalled(v) && v.ioPendingS >= 3),
    ),
    atCtx(
      before(DELAY),
      'no IO delay timeout before 15 s',
      (_s, ctx) => !eventSeen(ctx, 'fa.io-delay.timeout'),
    ),
    atCtx(by(DELAY), 'IO delay timeout fires on CT0', (_s, ctx) =>
      eventSeen(ctx, 'fa.io-delay.timeout', { device: CT0 }),
    ),
    at(
      by(RECOVERED),
      'CT1 is primary and the array serves IO',
      (s) => faController(s, CT1).role === 'primary' && fa(s).ioServing,
    ),
    allRunningAt(by(RECOVERED)),
    atCtx(END, 'timeout, giveback, then promotion', (_s, ctx) =>
      eventsInOrder(ctx, [
        { code: 'fa.io-delay.timeout', device: CT0 },
        { code: 'fa.giveback', device: CT0 },
        { code: 'fa.promotion.complete', device: CT1 },
      ]),
    ),
    always('pause stays within IO delay plus promotion', (s) => fa(s).pauseS <= RECOVERED + SLACK),
    at(END, 'CT0 is no longer primary', (s) => faController(s, CT0).role !== 'primary'),
    neverSeen(END, 'vm.io.guest-timeout'),
    ...baseInvariants(),
  ],
  narrative:
    'The primary controller stops completing IO but does not crash, so every VM stalls. After the 15 s IO delay timeout the primary gives back and the secondary promotes; the worst-case pause is the delay plus promotion, inside the 30 s failover objective. VMs resume without guest IO errors.',
  cite: ['everpure-ha-iodelay', 'everpure-ha-timing', 'everpure-ana-faq'],
  status: 'todo',
});
