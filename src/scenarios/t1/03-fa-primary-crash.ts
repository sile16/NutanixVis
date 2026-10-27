import { defineScenario } from '../define';
import {
  allCvms,
  allRunningAt,
  allVms,
  always,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  by,
  eventSeen,
  fa,
  faController,
  faInterfacesOn,
  neverSeen,
  onlyPathsLostTo,
  SLACK,
  T0,
  t1Steady,
} from '../helpers';
import { CT0, CT1, T1 } from '../ids';
import { KATO, P, PATH_LOSS_WORST } from '../timers';

const PAUSE = P.flasharray.primaryCrashPauseS;
const WORST = Math.max(PAUSE, PATH_LOSS_WORST);
const END = by(WORST) + 60;

export default defineScenario({
  id: 't1-03-fa-primary-crash',
  title: 'T1: FlashArray primary controller crashes',
  topology: T1.topology,
  durationS: END,
  timeline: [{ at: T0, action: { kind: 'fail', target: CT0 }, note: 'CT0 (primary) crashes.' }],
  expect: [
    ...t1Steady(),
    at(T0, 'CT0 is primary before the crash', (s) => fa(s).primary === CT0),
    atCtx(by(P.flasharray.claimExpiryDetectS), 'CT1 sees the claim expire', (_s, ctx) =>
      eventSeen(ctx, 'fa.claim.expired', { device: CT1 }),
    ),
    atCtx(
      by(PAUSE),
      'CT1 promotes within the crash pause',
      (s, ctx) =>
        eventSeen(ctx, 'fa.promotion.complete', { device: CT1 }) &&
        faController(s, CT1).role === 'primary' &&
        faController(s, CT0).role === 'offline' &&
        fa(s).ioServing,
    ),
    always('array-wide pause never exceeds the crash pause', (s) => fa(s).pauseS <= PAUSE + SLACK),
    at(by(KATO), "every CVM loses exactly CT0's paths (its ports disappear)", (s) =>
      allCvms(s, (c) => onlyPathsLostTo(c, faInterfacesOn(s, CT0))),
    ),
    allRunningAt(by(WORST)),
    alwaysFrom(T0, 'no command waits longer than the pause or KATO + CQT', (s) =>
      allVms(s, (v) => v.ioPendingS <= WORST + SLACK),
    ),
    neverSeen(END, 'vm.io.guest-timeout'),
    neverSeen(END, 'ha.vm.restarted'),
    ...baseInvariants(),
  ],
  narrative:
    "The primary controller CT0 crashes. CT1 sees the drive-quorum claim expire in about a second and promotes; the array serves no IO for a few seconds up to about 16 s. CT0's front-end ports disappear, so each CVM loses its two CT0 paths and continues on CT1's, all ANA Optimized. The pause is well under the guest SCSI timeout, so VMs only see latency.",
  cite: ['everpure-ha-crash', 'everpure-ana-faq', 'everpure-npiv', 'nvme-base-spec'],
  status: 'active',
});
