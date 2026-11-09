import { defineScenario } from '../define';
import {
  allCvms,
  allPathsLive,
  allVms,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  cvms,
  device,
  eventsInOrder,
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
import { CT0, CT1, T1, vmId } from '../ids';
import { arrayStepsOf, guideChecks, stepsOf } from '../steps';
import { KATO, P } from '../timers';

const VM = vmId(1, 1);
const DRAIN = P.flasharray.plannedRebootDrainS;
const REBOOT = P.flasharray.controllerRebootS;
const ONLINE = T0 + DRAIN + REBOOT;
/** After the controller is back: every host reconnects to its ports. */
const END = ONLINE + P.externalStorage.reconnectDelayS + P.externalStorage.keepAliveTimeoutS + 10;

/**
 * Steps view of a planned reboot of the secondary controller. The array's own run carries the
 * steps (no VM stalls): the controller drains (step 1), reboots (step 2) and is back online two to
 * three steps later.
 */
const GUIDE = {
  vm: VM,
  groups: [
    [
      {
        stage: 'controller-draining',
        step: 1,
        io: 'none',
        text: "CT1 stops taking new IO: it answers ANA Inaccessible, so every host sends its IO to CT0's paths at once. The IO already in flight finishes. No VM IO stalls.",
      },
      {
        stage: 'controller-rebooting',
        step: 2,
        text: 'With nothing in flight on it, CT1 reboots and its ports disappear. The hosts lose those paths without any IO waiting on them.',
      },
      {
        stage: 'controller-online',
        step: 5,
        text: 'CT1 is back online as secondary; the hosts reconnect and use its paths again.',
      },
    ],
  ],
} as const;

const held = (s: Parameters<typeof cvms>[0]): number =>
  cvms(s).reduce((n, c) => {
    const v = device(s, c.id).fields.nvmeIoHeld;
    return n + (typeof v === 'number' ? v : 0);
  }, 0);

const inaccessible = (s: Parameters<typeof cvms>[0], cvm: string): readonly string[] => {
  const raw = device(s, cvm).fields.nvmePathsInaccessible;
  return typeof raw === 'string' ? (JSON.parse(raw) as string[]) : [];
};

export default defineScenario({
  id: 't1-35-steps-planned-controller-reboot',
  title: 'T1 steps: planned reboot of the secondary controller (drain, reboot, back online)',
  topology: T1.topology,
  options: { 'node-count': 3, 'vm-layout': 'two', 'storage-vswitch-layout': 'per-fabric' },
  durationS: END,
  timeline: [
    {
      at: T0,
      action: { kind: 'fa.controller.reboot', target: CT1 },
      note: 'Reboot CT1 (secondary), planned.',
    },
  ],
  expect: [
    ...t1Steady(),
    atCtx(END, 'CT1 drains, reboots, then comes back online', (_s, ctx) =>
      eventsInOrder(ctx, [
        { code: 'fa.controller.draining', device: CT1 },
        { code: 'fa.controller.rebooting', device: CT1 },
        { code: 'fa.controller.online', device: CT1 },
      ]),
    ),
    alwaysFrom(
      T0,
      'no array-wide pause; CT0 stays primary',
      (s) => fa(s).ioServing && fa(s).pauseS === 0 && faController(s, CT0).role === 'primary',
    ),
    alwaysFrom(T0, 'no VM IO stalls at any point', (s) =>
      allVms(s, (v) => isRunning(v) && v.ioPendingS <= SLACK),
    ),
    alwaysFrom(T0, 'no host ever holds a command waiting on a lost path', (s) => held(s) === 0),
    at(T0 + KATO, "while CT1 drains, every CVM has marked CT1's paths inaccessible", (s) => {
      const ct1 = faInterfacesOn(s, CT1);
      return cvms(s).every((c) => {
        const off = inaccessible(s, c.id);
        return off.length > 0 && off.every((p) => ct1.some((i) => p.endsWith(`~${i}`)));
      });
    }),
    at(T0 + DRAIN + KATO, "while CT1 reboots, every CVM has lost exactly CT1's paths", (s) =>
      allCvms(s, (c) => onlyPathsLostTo(c, faInterfacesOn(s, CT1))),
    ),
    neverSeen(END, 'nvme.all-paths.lost'),
    atCtx(
      END,
      'steps: the counter runs on the array operation; no VM is interrupted',
      (_s, ctx) => {
        const op = arrayStepsOf(ctx);
        return op.startT !== null && op.endT !== null && stepsOf(ctx, VM).startT === null;
      },
    ),
    at(END, 'every CVM has all paths back', (s) => allCvms(s, allPathsLive)),
    ...guideChecks(GUIDE, END),
    ...baseInvariants(),
  ],
  narrative:
    "A planned reboot of the secondary controller, with no VM IO stall at any point. CT1 first stops taking new IO: it answers ANA Inaccessible, so the hosts retry on CT0's paths at once and stop using CT1's, while the IO already in flight finishes (step 1). Then CT1 reboots and its ports disappear (step 2); nothing is in flight on them, so no IO waits. CT1 is back online as secondary a few steps later and the hosts reconnect.",
  guide: GUIDE,
  cite: ['everpure-upgrade', 'everpure-ana-faq', 'everpure-npiv', 'nvme-base-spec-2.1'],
  status: 'active',
});
