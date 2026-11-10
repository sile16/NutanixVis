/**
 * Guided 3: one storage NIC (node 1 eth2) fails, then returns. The one fault where two vSwitches
 * without a bond do worse (a short partial stall) and where a MAC-pinning bond's return leaves
 * the node swapped (docs/research/ovs-bond-behavior.md S3).
 */
import type { T1Config } from '../../topologies/t1-configs';
import { defineScenario, type GuideObservation, type ScenarioGuide } from '../define';
import { atCtx, baseInvariants, neverSeen, T0, vswitch } from '../helpers';
import { T1 } from '../ids';
import { guideChecks } from '../steps';
import { P } from '../timers';
import {
  ALL_CONFIGS,
  type GuidedFamily,
  guidedId,
  guidedSteady,
  islShareOver,
  layoutWords,
  VM1,
} from './kit';

const BACK_AT = T0 + 60;
/** Several rebalance passes after the NIC returns. */
const END = BACK_AT + 4 * P.bond.slbRebalanceIntervalS;

function observations(c: T1Config): readonly (readonly GuideObservation[])[] {
  if (c.bond === 'none') {
    return [
      [
        {
          stage: 'stall',
          step: 1,
          io: 'partial',
          text: "eth2 is vs1's only uplink: storage-a's paths are cut. The commands queued on them stall (the VM shows the share); storage-b's paths through eth3 carry on.",
        },
        {
          stage: 'path-rerouted',
          step: 1,
          text: "Keep-alive declares storage-a's paths lost: new IO goes only to storage-b's.",
        },
        {
          stage: 'resumed',
          step: 2,
          text: "The stuck commands are retried on storage-b's paths: all IO completes again. Without a bond, NVMe multipathing is the only redundancy, so this is the one fault where this layout does worse than a bond.",
        },
      ],
      [
        {
          stage: 'path-restored',
          text: "eth2 is back: storage-a's paths reconnect and take IO again. The layout is exactly as before.",
        },
      ],
    ];
  }
  if (c.bond === 'lacp') {
    return [
      [
        {
          io: 'none',
          text: 'LACP takes eth2 out of the aggregate and every connection hashed to it moves to eth3 at once. No NVMe path is lost and no IO stalls: the step counter stays at 0.',
        },
      ],
      [
        {
          io: 'none',
          text: 'eth2 rejoins the aggregate and the connections spread over both members again. LACP hashes each connection, so nothing stays where the failure left it.',
        },
      ],
    ];
  }
  const four = c.arrayIps === 4;
  return [
    [
      {
        io: 'none',
        text: `The bond moves storage-a's MAC to eth3: both storage interfaces now share eth3 and Switch B. No NVMe path is lost and no IO stalls: the step counter stays at 0.${four ? " storage-a's IO now crosses the ISL to reach its VLAN's array ports on Switch A." : ''}`,
      },
    ],
    [
      {
        io: 'none',
        text: four
          ? "eth2 rejoins the bond, and at the next rebalance pass OVS moves one interface onto it: storage-b, not storage-a. Node 1 is now swapped like node 2, each interface on the switch away from its array ports, so all of node 1's storage IO crosses the ISL. Nothing alerts: the bond, both links and both switches are healthy, and OVS never moves it back."
          : "eth2 rejoins the bond, and at the next rebalance pass OVS moves one interface onto it: storage-b, not storage-a. Node 1 is now swapped like node 2, and OVS never moves it back. With 8 array IPs every VLAN has ports on both switches, so the swap costs nothing: about half of each node's IO crosses the ISL whatever the pinning.",
      },
    ],
  ];
}

function build(c: T1Config) {
  const guide: ScenarioGuide = { vm: VM1, groups: observations(c) };
  const slb = c.bond === 'mac-pinning';
  return defineScenario({
    id: guidedId(3, 'storage-nic', c.key),
    title: 'A storage NIC fails, then returns',
    topology: T1.topology,
    options: c.options,
    durationS: END,
    timeline: [
      { at: T0, action: { kind: 'fail', target: T1.storageNicA(1) }, note: 'Node 1 eth2 fails.' },
      {
        at: BACK_AT,
        action: { kind: 'recover', target: T1.storageNicA(1) },
        note: 'eth2 returns.',
      },
    ],
    expect: [
      ...guidedSteady(),
      ...(c.bond === 'none' ? [] : [neverSeen(END, 'nvme.path.lost')]),
      ...(slb
        ? [
            atCtx(END, 'node 1 came back swapped: storage-a on eth3, storage-b on eth2', (s) => {
              const pin = vswitch(s, T1.storageVs(1)).pinning;
              return pin[T1.segA(1)] === T1.storageNicB(1) && pin[T1.segB(1)] === T1.storageNicA(1);
            }),
            atCtx(
              END,
              c.arrayIps === 4
                ? "before: none of node 1's IO crossed the ISL; after: all of it"
                : "about half of node 1's IO crosses the ISL before and after",
              (_s, ctx) => {
                const before = islShareOver(ctx, T0 - 5, T0 - 1, 1, 'out') ?? -1;
                const after = islShareOver(ctx, END - 5, END, 1, 'out') ?? -1;
                return c.arrayIps === 4
                  ? before === 0 && after === 1
                  : Math.abs(before - 0.5) < 0.2 && Math.abs(after - 0.5) < 0.2;
              },
            ),
          ]
        : []),
      ...guideChecks(guide, END),
      ...baseInvariants(),
    ],
    guide,
    narrative:
      c.bond === 'none'
        ? `With ${layoutWords(c)}, node 1's eth2 fails. vs1 has no other uplink, so storage-a's paths are lost and the commands queued on them stall until keep-alive retries them on storage-b's paths: a short, partial interruption. A bond would have moved the vNIC instead, with no stall at all.`
        : c.bond === 'lacp'
          ? `With ${layoutWords(c)}, node 1's eth2 fails and returns. LACP moves the connections to eth3 and back without losing a path or stalling any IO. Each connection is hashed afresh, so nothing is left where the failure put it.`
          : `With ${layoutWords(c)}, node 1's eth2 fails and returns. The bond moves storage-a to eth3 without a stall, but when eth2 returns OVS rebalances storage-b onto it, so node 1 ends up swapped. ${c.arrayIps === 4 ? 'From then on all its storage IO crosses the ISL, and nothing alerts.' : 'With 8 array IPs that costs nothing, since every VLAN has ports on both switches.'}`,
    cite: ['ntnx-ahv-admin-11.2', 'ovs-bonding', 'ovs-bond-source', 'everpure-nutanix-net-bp'],
    status: 'active',
  });
}

const family: GuidedFamily = {
  n: 3,
  slug: 'storage-nic',
  title: 'A storage NIC fails, then returns',
  configs: ALL_CONFIGS,
  build,
};
export default family;
