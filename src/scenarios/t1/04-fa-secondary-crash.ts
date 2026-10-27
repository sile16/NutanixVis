import { defineScenario } from '../define';
import {
  allCvms,
  allVms,
  alwaysFrom,
  at,
  baseInvariants,
  by,
  fa,
  faController,
  faInterfacesOn,
  isRunning,
  neverSeen,
  onlyPathsLostTo,
  SLACK,
  T0,
  t1Steady,
} from '../helpers';
import { CT0, CT1, T1 } from '../ids';
import { KATO, PATH_LOSS_WORST } from '../timers';

const END = by(PATH_LOSS_WORST) + 60;

export default defineScenario({
  id: 't1-04-fa-secondary-crash',
  title: 'T1: FlashArray secondary controller crashes',
  topology: T1.topology,
  durationS: END,
  timeline: [{ at: T0, action: { kind: 'fail', target: CT1 }, note: 'CT1 (secondary) crashes.' }],
  expect: [
    ...t1Steady(),
    alwaysFrom(T0, 'no array-wide pause', (s) => fa(s).ioServing && fa(s).pauseS === 0),
    alwaysFrom(T0, 'CT0 stays primary', (s) => faController(s, CT0).role === 'primary'),
    at(by(KATO), "every CVM loses exactly CT1's paths", (s) =>
      allCvms(s, (c) => onlyPathsLostTo(c, faInterfacesOn(s, CT1))),
    ),
    alwaysFrom(T0, 'VMs keep running (latency outliers only)', (s) => allVms(s, isRunning)),
    alwaysFrom(T0, "only IO in flight on CT1's paths waits, at most KATO + CQT", (s) =>
      allVms(s, (v) => v.ioPendingS <= PATH_LOSS_WORST + SLACK),
    ),
    neverSeen(END, 'fa.promotion.start'),
    ...baseInvariants(),
  ],
  narrative:
    "The secondary controller CT1 crashes. There is no array-wide pause: CT0 keeps the drives and keeps serving. CT1's paths go silent and are declared lost one keep-alive timeout later; new IO moves to CT0's paths at once, and commands caught in flight are retried after the quiesce time.",
  cite: ['everpure-ha-secondary', 'everpure-ana-faq', 'nvme-base-spec'],
  status: 'active',
});
