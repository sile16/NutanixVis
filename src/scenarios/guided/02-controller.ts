/**
 * Guided 2: the primary FlashArray controller crashes, comes back as the secondary, then gets a
 * planned reboot (as in an upgrade) for contrast: a crash pauses every IO until the partner takes
 * over, a planned reboot drains first and pauses nothing.
 */
import type { T1Config } from '../../topologies/t1-configs';
import { defineScenario, type ScenarioGuide } from '../define';
import { atCtx, baseInvariants, faController, neverSeen, T0 } from '../helpers';
import { CT0, CT1, T1 } from '../ids';
import { guideChecks, stepsOf } from '../steps';
import { ALL_CONFIGS, type GuidedFamily, guidedId, guidedSteady, layoutWords, VM1 } from './kit';

const BACK_AT = T0 + 140;
const REBOOT_AT = T0 + 290;
const END = REBOOT_AT + 200;

function build(c: T1Config) {
  const guide: ScenarioGuide = {
    vm: VM1,
    groups: [
      [
        {
          stage: 'stall',
          step: 1,
          io: 'all',
          text: "CT0, the primary, crashes. Every IO in flight stalls: CT0's paths are gone and CT1 needs a moment to take over as primary.",
        },
        {
          stage: 'path-rerouted',
          step: 1,
          text: "Keep-alive declares CT0's paths lost: IO now waits for CT1.",
        },
        {
          stage: 'resumed',
          step: 2,
          text: 'CT1 is primary: the stuck commands complete on its paths. The VM saw a pause, never an error.',
        },
        {
          text:
            c.bond === 'none'
              ? 'Nothing on the hosts changes: no NIC, vSwitch or switch is involved, only the NVMe paths to CT0.'
              : 'Nothing on the hosts changes: no bond member, vSwitch or switch is involved, only the NVMe paths to CT0.',
        },
      ],
      [
        {
          stage: 'path-restored',
          text: 'CT0 boots and rejoins as the secondary: its paths reconnect. CT1 stays primary; there is no failback.',
        },
      ],
      [
        {
          stage: 'controller-draining',
          text: 'Now a planned reboot of CT0, as in a Purity upgrade: it drains first, so its paths carry no IO when it goes.',
        },
        { stage: 'controller-rebooting', text: 'CT0 reboots.' },
        {
          stage: 'controller-online',
          text: 'CT0 is back online. No IO paused this time: a drained controller has nothing in flight, unlike a crash.',
        },
      ],
    ],
  };
  return defineScenario({
    id: guidedId(2, 'controller', c.key),
    title: 'A FlashArray controller crashes',
    topology: T1.topology,
    options: c.options,
    durationS: END,
    timeline: [
      { at: T0, action: { kind: 'fail', target: CT0 }, note: 'CT0 (the primary) crashes.' },
      { at: BACK_AT, action: { kind: 'recover', target: CT0 }, note: 'CT0 boots again.' },
      {
        at: REBOOT_AT,
        action: { kind: 'fa.controller.reboot', target: CT0 },
        note: 'Planned reboot of CT0 (now the secondary).',
      },
    ],
    expect: [
      ...guidedSteady(),
      atCtx(
        BACK_AT - 1,
        'CT1 took over as primary',
        (s) => faController(s, CT1).role === 'primary',
      ),
      atCtx(
        REBOOT_AT - 1,
        'CT0 rejoined as the secondary',
        (s) => faController(s, CT0).role === 'secondary',
      ),
      atCtx(END, 'the planned reboot paused no IO: one stall, from the crash only', (_s, ctx) => {
        const st = stepsOf(ctx, VM1);
        return st.resumeStep !== null && (st.endT ?? Number.POSITIVE_INFINITY) < BACK_AT;
      }),
      neverSeen(END, 'hades.maintenance.enter'),
      ...guideChecks(guide, END),
      ...baseInvariants(),
    ],
    guide,
    narrative: `With ${layoutWords(c)}, the primary controller crashes: every IO in flight pauses until CT1 takes over, then completes, with no error to the VM. CT0 comes back as the secondary, and a planned reboot of it afterwards drains first and pauses nothing. The host network plays no part, so this runs the same on every topology.`,
    cite: ['everpure-ha-crash', 'everpure-upgrade', 'everpure-ana-faq', 'nvme-base-spec-2.1'],
    status: 'active',
  });
}

const family: GuidedFamily = {
  n: 2,
  slug: 'controller',
  title: 'A FlashArray controller crashes',
  configs: ALL_CONFIGS,
  build,
};
export default family;
