/**
 * Guided 7: the Stargate process in CVM 1 crashes. New for an array engineer: a VM's disk is
 * served by the Stargate in the CVM on its own host, and the AHV IO redirector (Frodo) logs the
 * VM's session in to a Stargate on another CVM when its own dies (Bible "Autopath").
 */
import type { T1Config } from '../../topologies/t1-configs';
import { defineScenario, type ScenarioGuide } from '../define';
import { atCtx, baseInvariants, isRunning, neverSeen, T0, vm } from '../helpers';
import { T1 } from '../ids';
import { guideChecks } from '../steps';
import { ALL_CONFIGS, type GuidedFamily, guidedId, guidedSteady, layoutWords, VM1 } from './kit';

const END = T0 + 400;

function build(c: T1Config) {
  const guide: ScenarioGuide = {
    vm: VM1,
    groups: [
      [
        {
          stage: 'stall',
          step: 1,
          io: 'all',
          text: "Stargate in CVM 1 crashes. VM 1-1's IO stalls: on Nutanix the VM does not talk to the array; its disk is served by the Stargate in the CVM on its own host, which talks NVMe to the array.",
        },
        {
          stage: 'redirected',
          step: 1,
          text: 'Frodo, the IO redirector in the AHV host, sees the session drop and logs VM 1-1 in to a Stargate on another CVM, over the network.',
        },
        {
          stage: 'resumed',
          step: 1,
          text: 'IO resumes through the remote Stargate, which reaches the same array volumes over its own paths. The VM kept running throughout.',
        },
        {
          stage: 'services-restarted',
          step: 1,
          text: 'Stargate restarts in CVM 1 at once: a process crash, not a CVM failure.',
        },
        {
          text:
            c.bond === 'none'
              ? 'The storage network plays no part: this runs the same on every topology.'
              : "The storage network plays no part: this runs the same on every topology, except that the remote Stargate's own paths may cross the ISL.",
        },
      ],
    ],
  };
  return defineScenario({
    id: guidedId(7, 'stargate', c.key),
    title: 'Stargate crashes in a CVM',
    topology: T1.topology,
    options: c.options,
    durationS: END,
    timeline: [
      {
        at: T0,
        action: { kind: 'cvm.crash-stargate', target: 'node-1.cvm' },
        note: 'Stargate in CVM 1 crashes.',
      },
    ],
    expect: [
      ...guidedSteady(),
      atCtx(END, 'VM 1-1 kept running and its host never changed', (s) => {
        const v = vm(s, VM1);
        return isRunning(v) && v.host === 'node-1';
      }),
      neverSeen(END, 'hades.maintenance.enter'),
      neverSeen(END, 'vm.io.guest-timeout'),
      ...guideChecks(guide, END),
      ...baseInvariants(),
    ],
    guide,
    narrative: `With ${layoutWords(c)}, the Stargate process in CVM 1 crashes. VM 1-1's IO stalls briefly until Frodo, the redirector in the AHV host, logs it in to a Stargate on another CVM, and IO resumes there while Stargate restarts locally. The VM never restarts and never sees an error.`,
    cite: ['ntnx-bible-5b', 'ntnx-blog-cvm-failure', 'ntnx-kb-io-freeze-cvm-down'],
    status: 'active',
  });
}

const family: GuidedFamily = {
  n: 7,
  slug: 'stargate',
  title: 'Stargate crashes in a CVM',
  configs: ALL_CONFIGS,
  build,
};
export default family;
