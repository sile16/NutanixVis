/**
 * Guided 10: node 1's eth2 hangs: carrier stays up, frames vanish (a bad optic, a wedged switch
 * port). Carrier-watching bonds (MAC pinning) and plain vSwitches never notice; NVMe keep-alive
 * finds the dead paths. LACP notices on its own when the LACPDUs stop and moves the connections
 * (OVS `lib/lacp.c`), before keep-alive would.
 */
import type { T1Config } from '../../topologies/t1-configs';
import { defineScenario, type GuideObservation, type ScenarioGuide } from '../define';
import { atCtx, baseInvariants, eventSeen, neverSeen, T0 } from '../helpers';
import { T1 } from '../ids';
import { guideChecks } from '../steps';
import { ALL_CONFIGS, type GuidedFamily, guidedId, guidedSteady, layoutWords, VM1 } from './kit';

const BACK_AT = T0 + 140;
const END = BACK_AT + 40;

function groups(c: T1Config): readonly (readonly GuideObservation[])[] {
  if (c.bond === 'lacp') {
    return [
      [
        {
          stage: 'stall',
          step: 1,
          io: 'all',
          text: "eth2 hangs with its link up. With LACP every connection touches eth2 one way or the other: hashed onto it on the way out, or answered through it by Switch A. So all of VM 1-1's IO stalls for a moment.",
        },
        {
          stage: 'resumed',
          step: 1,
          text: "LACP stops hearing eth2's LACPDUs and takes it out of the aggregate (fast rate): every connection moves to eth3 and IO resumes in the same step. No NVMe path is ever lost.",
        },
      ],
      [{ text: 'eth2 works again: its LACPDUs return and it rejoins the aggregate.' }],
    ];
  }
  const eight = c.arrayIps === 8;
  const who =
    c.bond === 'none'
      ? "vs1 has only eth2, and nothing watches more than its carrier: storage-a's frames vanish."
      : 'MAC pinning only watches carrier, so the bond keeps storage-a pinned to the hung eth2 and its frames vanish.';
  return [
    [
      {
        stage: 'stall',
        step: 1,
        io: eight ? 'all' : 'partial',
        text: eight
          ? `eth2 hangs with its link up. ${who} Its four paths look idle, so the queue-depth selector keeps handing them IO until every slot of the VM's queue waits there: all of its IO stalls.`
          : `eth2 hangs with its link up. ${who} The commands queued on its paths stall (the VM shows the share); storage-b's paths carry on.`,
      },
      {
        stage: 'path-rerouted',
        step: 1,
        text: "NVMe keep-alive notices instead: storage-a's paths are declared lost and new IO goes to storage-b's.",
      },
      {
        stage: 'resumed',
        step: 2,
        text: "The stuck commands are retried on storage-b's paths: all IO completes again.",
      },
    ],
    [
      {
        stage: 'path-restored',
        text: "eth2 works again: storage-a's paths reconnect and take IO again.",
      },
    ],
  ];
}

function build(c: T1Config) {
  const guide: ScenarioGuide = { vm: VM1, groups: groups(c) };
  const lacp = c.bond === 'lacp';
  return defineScenario({
    id: guidedId(10, 'nic-hang', c.key),
    title: 'A storage NIC hangs, link up',
    topology: T1.topology,
    options: c.options,
    durationS: END,
    timeline: [
      {
        at: T0,
        action: { kind: 'hang', target: T1.storageNicA(1) },
        note: 'Node 1 eth2 hangs: link up, frames dropped.',
      },
      {
        at: BACK_AT,
        action: { kind: 'unhang', target: T1.storageNicA(1) },
        note: 'eth2 works again.',
      },
    ],
    expect: [
      ...guidedSteady(),
      ...(lacp
        ? [
            neverSeen(END, 'nvme.path.lost'),
            atCtx(END, 'LACP detected the hang on its own', (_s, ctx) =>
              eventSeen(ctx, 'net.bond.lacp-timeout', { from: T0 }),
            ),
          ]
        : [neverSeen(END, 'net.bond.failover')]),
      neverSeen(END, 'hades.maintenance.enter'),
      ...guideChecks(guide, END),
      ...baseInvariants(),
    ],
    guide,
    narrative: lacp
      ? `With ${layoutWords(c)}, node 1's eth2 hangs while its link stays up. Every connection touches eth2 in one direction or the other, so all IO stalls, but LACP notices the missing LACPDUs and moves everything to eth3 within the same step, before NVMe loses a path. This is the fault where LACP does best.`
      : `With ${layoutWords(c)}, node 1's eth2 hangs while its link stays up. ${c.bond === 'none' ? 'The vSwitch' : 'The MAC-pinning bond'} watches only carrier and never notices, so NVMe keep-alive has to find the dead paths and retry their IO on storage-b's. LACP, which watches its LACPDUs, would have moved the traffic on its own.`,
    cite: ['ovs-lacp-source', 'ovs-bonding', 'ntnx-ahv-admin-11.2', 'nvme-base-spec-2.1'],
    status: 'active',
  });
}

const family: GuidedFamily = {
  n: 10,
  slug: 'nic-hang',
  title: 'A storage NIC hangs, link up',
  configs: ALL_CONFIGS,
  build,
};
export default family;
