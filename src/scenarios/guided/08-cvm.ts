/**
 * Guided 8: CVM 1 fails while node 1 stays up. Its VMs keep running; Frodo (the AHV IO
 * redirector) moves their sessions to a Stargate on another CVM, and back once CVM 1 has been
 * healthy for a while (Bible "Autopath"; failback is far slower than failover).
 */
import type { T1Config } from '../../topologies/t1-configs';
import { defineScenario, type ScenarioGuide } from '../define';
import { alwaysFrom, baseInvariants, isRunning, neverSeen, T0, vm } from '../helpers';
import { T1 } from '../ids';
import { guideChecks } from '../steps';
import { ALL_CONFIGS, type GuidedFamily, guidedId, guidedSteady, layoutWords, VM1 } from './kit';

const BACK_AT = T0 + 190;
const END = BACK_AT + 600;

function build(c: T1Config) {
  const guide: ScenarioGuide = {
    vm: VM1,
    groups: [
      [
        {
          stage: 'stall',
          step: 1,
          io: 'all',
          text: "CVM 1, the storage controller VM on node 1, fails. Node 1 and VM 1-1 keep running, but VM 1-1's IO stalls: its local Stargate is gone.",
        },
        {
          stage: 'redirected',
          step: 2,
          text: "Frodo, the IO redirector in the AHV host, finds CVM 1 silent (its NOPs go unanswered) and logs VM 1-1's session in to a Stargate on another CVM.",
        },
        {
          stage: 'resumed',
          step: 3,
          text: 'IO resumes through the remote CVM, over the network. The VM never restarted: a controller failure costs a pause, as on a dual-controller array.',
        },
      ],
      [
        {
          stage: 'services-restarted',
          text: 'CVM 1 boots and its Stargate serves again. VM 1-1 stays on the remote Stargate for now.',
        },
        {
          stage: 'failed-back',
          text: 'Only after CVM 1 has stayed healthy for a while does Frodo move the session back home: failback is much slower than failover, by design.',
        },
      ],
    ],
  };
  return defineScenario({
    id: guidedId(8, 'cvm', c.key),
    title: 'A CVM fails, its host stays up',
    topology: T1.topology,
    options: c.options,
    durationS: END,
    timeline: [
      {
        at: T0,
        action: { kind: 'fail', target: 'node-1.cvm' },
        note: 'CVM 1 fails; node 1 stays up.',
      },
      { at: BACK_AT, action: { kind: 'recover', target: 'node-1.cvm' }, note: 'CVM 1 comes back.' },
    ],
    expect: [
      ...guidedSteady(),
      alwaysFrom(T0, 'VM 1-1 keeps running on node 1 throughout', (s) => {
        const v = vm(s, VM1);
        return isRunning(v) || v.state === 'io-stalled';
      }),
      neverSeen(END, 'vm.io.guest-timeout'),
      neverSeen(END, 'ha.vm.restarted'),
      ...guideChecks(guide, END),
      ...baseInvariants(),
    ],
    guide,
    narrative: `With ${layoutWords(c)}, CVM 1 fails while its host keeps running. Frodo, the redirector in the AHV host, moves VM 1-1's IO to a Stargate on another CVM after a short stall, so the VM never restarts. Once CVM 1 is back and has stayed healthy, the session moves home again, much later than it left.`,
    cite: ['ntnx-ahv-admin-11.2', 'ntnx-bible-5b', 'ntnx-bible-8c', 'ntnx-blog-cvm-failure'],
    status: 'active',
  });
}

const family: GuidedFamily = {
  n: 8,
  slug: 'cvm',
  title: 'A CVM fails, its host stays up',
  configs: ALL_CONFIGS,
  build,
};
export default family;
