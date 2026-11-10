/**
 * Guided 4: why storage IO crosses the inter-switch link (ISL) on a bonded storage vSwitch.
 * MAC pinning: node 2 booted swapped, so its storage interfaces sit on the switch away from their
 * VLANs' array ports and all its IO crosses the ISL both ways; moving them back by hand
 * (`ovs-appctl bond/migrate`) fixes it. LACP: each connection is hashed onto a member on the way
 * out, while the array side's switch sends every reply out its own member of the port-channel, so
 * the way back stays local until that member is gone (docs/research/ovs-bond-behavior.md).
 */
import type { T1Config } from '../../topologies/t1-configs';
import { defineScenario, type GuideObservation, type ScenarioGuide } from '../define';
import { atCtx, baseInvariants, neverSeen, T0, vswitch } from '../helpers';
import { T1 } from '../ids';
import { guideChecks } from '../steps';
import {
  BONDED_CONFIGS,
  type GuidedFamily,
  guidedId,
  guidedSteady,
  islShareOver,
  layoutWords,
  VM1,
  VM2,
} from './kit';

const THEN_AT = T0 + 60;
const END = THEN_AT + 40;

const near = (x: number | null, want: number, tol = 0.2): boolean =>
  x !== null && Math.abs(x - want) <= tol;

function slbGuide(c: T1Config): readonly (readonly GuideObservation[])[] {
  const four = c.arrayIps === 4;
  return [
    [
      {
        io: 'none',
        text: four
          ? 'Before: node 2 booted with eth3 up first, so storage-a (VLAN A, whose array ports are on Switch A) is pinned to eth3 on Switch B, and storage-b the other way round. Every IO of node 2 crosses the ISL, out and back; node 1, which booted home, crosses none. Hover the ISL to see why.'
          : 'Before: node 2 booted swapped, yet with 8 array IPs every VLAN has ports on both switches: each interface reaches two of its four portals locally and two over the ISL, so about half of every node’s IO crosses it, swapped or not.',
      },
      {
        io: 'none',
        text: four
          ? "Moving node 2's interfaces back (bond/migrate, not offered in Prism) brings its ISL share to zero. No IO stalls: the switches learn the MACs on the new ports at once."
          : "Moving node 2's interfaces back changes nothing: the ISL share stays about half. Here the swap never mattered.",
      },
    ],
  ];
}

const LACP_GUIDE: readonly (readonly GuideObservation[])[] = [
  [
    {
      io: 'none',
      text: "Before: LACP hashes each of node 1's NVMe connections onto eth2 or eth3, so a connection to an array port on the other switch crosses the ISL on the way out. Replies never do: the array port's switch sends them out its own member of the port-channel (MLAG prefers the local link).",
    },
    {
      io: 'none',
      text: "With eth3 down, node 1 has no member on Switch B: replies from Switch B's array ports must now cross the ISL too. No IO stalls; the connections just take the longer way.",
    },
  ],
  [
    {
      io: 'none',
      text: 'eth3 is back: replies stay local again, and the way out is hashed over both members.',
    },
  ],
];

function build(c: T1Config) {
  const slb = c.bond === 'mac-pinning';
  const four = c.arrayIps === 4;
  const guide: ScenarioGuide = slb
    ? { vm: VM2, groups: slbGuide(c) }
    : { vm: VM1, groups: LACP_GUIDE };
  const timeline = slb
    ? [
        {
          at: T0,
          action: {
            kind: 'vswitch.rebalance',
            target: T1.storageVs(2),
            params: { vnic: T1.segA(2), member: T1.storageNicA(2) },
          },
          note: "Move node 2's storage interfaces back home (ovs-appctl bond/migrate).",
        },
        {
          at: T0,
          action: {
            kind: 'vswitch.rebalance',
            target: T1.storageVs(2),
            params: { vnic: T1.segB(2), member: T1.storageNicB(2) },
          },
        },
      ]
    : [
        { at: T0, action: { kind: 'fail', target: T1.storageNicB(1) }, note: 'Node 1 eth3 fails.' },
        {
          at: THEN_AT,
          action: { kind: 'recover', target: T1.storageNicB(1) },
          note: 'eth3 returns.',
        },
      ];
  const expect = slb
    ? [
        atCtx(
          END,
          four
            ? 'node 2: all of its IO crossed the ISL, then none'
            : 'node 2: about half crosses the ISL before and after',
          (_s, ctx) => {
            const before = islShareOver(ctx, T0 - 5, T0 - 1, 2, 'out');
            const after = islShareOver(ctx, END - 5, END, 2, 'out');
            const back = islShareOver(ctx, T0 - 5, T0 - 1, 2, 'back');
            return four
              ? before === 1 && back === 1 && after === 0
              : near(before, 0.5) && near(after, 0.5);
          },
        ),
        atCtx(END, 'node 2 is home: storage-a on eth2, storage-b on eth3', (s) => {
          const pin = vswitch(s, T1.storageVs(2)).pinning;
          return pin[T1.segA(2)] === T1.storageNicA(2) && pin[T1.segB(2)] === T1.storageNicB(2);
        }),
      ]
    : [
        atCtx(
          END,
          'replies stay local while both members are up',
          (_s, ctx) =>
            islShareOver(ctx, T0 - 5, T0 - 1, 1, 'back') === 0 &&
            islShareOver(ctx, END - 5, END, 1, 'back') === 0,
        ),
        atCtx(
          END,
          'some connections cross on the way out',
          (_s, ctx) => (islShareOver(ctx, T0 - 5, T0 - 1, 1, 'out') ?? 0) > 0,
        ),
        atCtx(
          END,
          'with eth3 down, replies from Switch B cross the ISL',
          (_s, ctx) => (islShareOver(ctx, THEN_AT - 10, THEN_AT - 1, 1, 'back') ?? 0) > 0.2,
        ),
      ];
  return defineScenario({
    id: guidedId(4, 'isl-traffic', c.key),
    title: 'Why storage traffic crosses the ISL',
    topology: T1.topology,
    options: c.options,
    durationS: END,
    timeline,
    expect: [
      ...guidedSteady(),
      ...expect,
      neverSeen(END, 'nvme.path.lost'),
      ...guideChecks(guide, END),
      ...baseInvariants(),
    ],
    guide,
    narrative: slb
      ? four
        ? `With ${layoutWords(c)}, each storage interface is pinned to one bond member, and the switches learn its MAC there. Node 2 booted swapped, so every IO it does crosses the ISL both ways, while node 1 crosses none. Moving its interfaces back by hand fixes it, until the next reboot or link event.`
        : `With ${layoutWords(c)}, each storage interface is pinned to one bond member, but every VLAN has array ports on both switches. So about half of every node's IO crosses the ISL whichever member an interface is pinned to, and node 2 booting swapped makes no difference.`
      : `With ${layoutWords(c)}, LACP hashes each connection onto a member on the way out, so some cross the ISL, while the array port's switch always sends the replies out its own member. When node 1 loses its member on Switch B, the replies from Switch B's array ports cross the ISL too.`,
    cite: ['ovs-bonding', 'ovs-bond-source', 'ntnx-ahv-admin-11.2', 'everpure-nutanix-net-bp'],
    status: 'active',
  });
}

const family: GuidedFamily = {
  n: 4,
  slug: 'isl-traffic',
  title: 'Why storage traffic crosses the ISL',
  configs: BONDED_CONFIGS,
  build,
};
export default family;
