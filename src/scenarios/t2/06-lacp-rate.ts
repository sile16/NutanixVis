import { defineScenario, type ScenarioDef } from '../define';
import {
  allRunningAt,
  allVms,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  before,
  by,
  eventSeen,
  neverSeen,
  SLACK,
  T0,
  vms,
  vswitch,
  wasEver,
} from '../helpers';
import { SW_A, T2 } from '../ids';
import { P } from '../timers';

function variant(rate: 'fast' | 'slow'): ScenarioDef {
  const detect = rate === 'fast' ? P.bond.lacpFastDetectS : P.bond.lacpSlowDetectS;
  const END = by(detect) + 30;
  return defineScenario({
    id: `t2-06-lacp-${rate}-member-failure`,
    title: `T2: LACP ${rate} rate, member failure without carrier loss`,
    topology: T2.topology,
    options: { 'vs0-bond-mode': 'balance-tcp', 'lacp-rate': rate, mlag: true },
    durationS: END,
    timeline: [
      {
        at: T0,
        action: { kind: 'switch.hang', target: SW_A },
        note: 'Switch A stops forwarding but keeps carrier on every port.',
      },
    ],
    expect: [
      allRunningAt(T0, 'steady state: all VMs running'),
      at(before(detect), 'bonds still count the Switch A member', (s) =>
        T2.nodes.every((n) => vswitch(s, T2.vs(n)).activeMembers === 2),
      ),
      atCtx(
        by(detect),
        `LACP ${rate} detaches the member`,
        (s, ctx) =>
          T2.nodes.every((n) => vswitch(s, T2.vs(n)).activeMembers === 1) &&
          eventSeen(ctx, 'net.bond.lacp-timeout'),
      ),
      allRunningAt(by(detect)),
      ...(rate === 'fast'
        ? [
            alwaysFrom(T0, 'flows on the hung member stall only until fast detection', (s) =>
              allVms(s, (v) => v.ioPendingS <= detect + SLACK),
            ),
            neverSeen(END, 'ha.host.disconnected'),
          ]
        : [
            atCtx(by(detect), 'some flows blackholed far longer than fast rate allows', (_s, ctx) =>
              wasEver(
                ctx,
                (s) => vms(s).some((v) => v.ioPendingS > P.bond.lacpFastDetectS + SLACK),
                T0,
              ),
            ),
          ]),
      ...baseInvariants(),
    ],
    narrative:
      rate === 'fast'
        ? 'Switch A hangs without dropping carrier, so only LACP can tell. At the fast rate each bond misses its LACP PDUs and detaches the Switch A member within about 3 s, and replication and cluster traffic rehash onto Switch B with only a brief stall.'
        : 'Switch A hangs without dropping carrier. At the slow rate LACP needs up to 90 s to detach the member, and every flow hashed onto it, whether VM replication, Stargate or cluster traffic, is blackholed until then. Match a fast rate on both the switch and the host.',
    cite: ['ntnx-ahv-admin-11.2', 'ovs-bonding'],
    status: 'active',
  });
}

export default [variant('fast'), variant('slow')];
