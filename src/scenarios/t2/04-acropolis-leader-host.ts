import { defineScenario } from '../define';
import {
  allRunningAt,
  at,
  atCtx,
  baseInvariants,
  before,
  by,
  derived,
  eventSeen,
  host,
  isRunning,
  T0,
  vmsOfNode,
} from '../helpers';
import { nodeId, T2 } from '../ids';
import { P } from '../timers';

const HA = P.ahvHa;
const LEADER = nodeId(1);
const END = by(HA.restartByS) + 30;

export default defineScenario({
  id: 't2-04-acropolis-leader-host-fails',
  title: 'T2: the host running the Acropolis leader fails',
  topology: T2.topology,
  durationS: END,
  timeline: [
    { at: T0, action: { kind: 'power-off', target: LEADER }, note: 'The leader host loses power.' },
  ],
  expect: [
    allRunningAt(T0, 'steady state: all VMs running'),
    at(
      T0,
      'node 1 holds the Acropolis leadership',
      (s) =>
        derived(s).acropolisLeader === LEADER &&
        host(s, LEADER).badges.includes('acropolis-leader'),
    ),
    at(
      before(HA.leaderReelectionS),
      'no new leader before T+20',
      (s) => derived(s).acropolisLeader === LEADER || derived(s).acropolisLeader === null,
    ),
    atCtx(by(HA.leaderReelectionS), 'a surviving host is elected leader at T+20', (s, ctx) => {
      const leader = derived(s).acropolisLeader;
      return (
        leader !== null &&
        leader !== LEADER &&
        eventSeen(ctx, 'ha.leader.elected', { device: leader })
      );
    }),
    at(by(HA.fenceAtS), 'node 1 fenced by T+60', (s) => host(s, LEADER).haState === 'fenced'),
    at(by(HA.restartByS), 'node 1 VMs restarted elsewhere by T+120', (s) =>
      vmsOfNode(s, 1).every((v) => isRunning(v) && v.host !== LEADER),
    ),
    ...baseInvariants(),
  ],
  narrative:
    'The host running the Acropolis leader fails, taking the HA coordinator with it. The surviving hosts elect a new leader at T+20, which is also when the 40 s disconnect timeout starts, so the HA timeline is unchanged: fence at T+60 and VM restarts by T+120.',
  cite: ['ntnx-bible-5b', 'ntnx-ahv-admin-11.2'],
  status: 'todo',
});
