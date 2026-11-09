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
  cvms,
  device,
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
import { P } from '../timers';

const PAUSE = P.flasharray.plannedFailoverPauseS;
/** Both reboots (each a drain, then the reboot), the host reconnects and the failover between. */
const END = 600;

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
    alwaysFrom(T0, 'VMs only ever wait out the failover pause; the reboots never stall them', (s) =>
      allVms(s, (v) => (isRunning(v) || isStalled(v)) && v.ioPendingS <= PAUSE + SLACK),
    ),
    atCtx(END, 'each controller drains before it reboots', (_s, ctx) =>
      eventsInOrder(ctx, [
        { code: 'fa.controller.draining', device: CT1 },
        { code: 'fa.controller.rebooting', device: CT1 },
        { code: 'fa.controller.draining', device: CT0 },
        { code: 'fa.controller.rebooting', device: CT0 },
      ]),
    ),
    alwaysFrom(T0, 'no host holds a command waiting on a rebooted controller', (s) =>
      cvms(s).every((c) => device(s, c.id).fields.nvmeIoHeld === 0),
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
    "A Purity upgrade reboots the secondary controller first. It drains before it reboots: new IO is answered ANA Inaccessible and retried on the primary's paths at once, so its ports disappear with nothing in flight and no VM IO stalls. Once it is back, the primary gives back and the upgraded controller promotes, with a short IO pause (at most 15 s). Then the old primary drains and reboots the same way and returns as secondary.",
  cite: ['everpure-ha-planned', 'everpure-upgrade', 'everpure-npiv', 'everpure-ana-faq'],
  status: 'active',
});
