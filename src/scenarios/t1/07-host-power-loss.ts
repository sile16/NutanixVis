import { defineScenario } from '../define';
import {
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  before,
  by,
  derived,
  eventsMatching,
  firstEventAt,
  host,
  isRunning,
  T0,
  t1Steady,
  vms,
  vmsOfNode,
  wasEver,
} from '../helpers';
import { nodeId, T1 } from '../ids';
import { P } from '../timers';

const HA = P.ahvHa;
const LOST = nodeId(2);
const END = by(HA.restartByS) + 30;

export default defineScenario({
  id: 't1-07-host-power-loss',
  title: 'T1: an AHV host loses power; HA restarts its VMs by T+120',
  topology: T1.topology,
  durationS: END,
  timeline: [{ at: T0, action: { kind: 'power-off', target: LOST }, note: 'Node 2 loses power.' }],
  expect: [
    ...t1Steady(),
    at(
      T0,
      'node 2 is not the Acropolis leader (see t2-04 for that case)',
      (s) => derived(s).acropolisLeader !== LOST,
    ),
    at(
      before(HA.fenceAtS),
      'node 2 not fenced before T+60',
      (s) => host(s, LOST).haState !== 'fenced',
    ),
    at(by(HA.fenceAtS), 'node 2 fenced by T+60', (s) => host(s, LOST).haState === 'fenced'),
    at(before(HA.fenceAtS), 'node 2 VMs are not running anywhere before the fence', (s) =>
      vmsOfNode(s, 2).every((v) => !isRunning(v)),
    ),
    at(by(HA.restartByS), 'node 2 VMs restarted on surviving hosts by T+120', (s) =>
      vmsOfNode(s, 2).every((v) => isRunning(v) && v.host !== null && v.host !== LOST),
    ),
    atCtx(by(HA.restartByS), 'restarts come after the fence', (_s, ctx) => {
      const fence = firstEventAt(ctx, 'ha.host.fenced', { device: LOST });
      const restarts = eventsMatching(ctx, 'ha.vm.restarted').filter((e) =>
        e.deviceId?.startsWith(`${LOST}.`),
      );
      return fence !== null && restarts.length === 2 && restarts.every((e) => e.t >= fence);
    }),
    atCtx(END, 'HA status went through Healing', (_s, ctx) =>
      wasEver(ctx, (s) => derived(s).haStatus === 'Healing', T0),
    ),
    at(
      by(HA.restartByS),
      'one more simultaneous node failure is tolerated (N−2 with 4 nodes)',
      (s) => derived(s).nodeFailureTolerance === 1,
    ),
    alwaysFrom(T0, 'VMs on other nodes keep running', (s) =>
      vms(s)
        .filter((v) => !v.id.startsWith(`${LOST}.`))
        .every(isRunning),
    ),
    alwaysFrom(T0, 'cluster services stay up', (s) => derived(s).clusterServices === 'up'),
    ...baseInvariants(),
  ],
  narrative:
    "Node 2 loses power. The Acropolis leader stops getting heartbeats; at T+20 the 40 s timeout starts, at T+60 Stargates fence the host's IO, and by T+120 its VMs restart on the surviving nodes. The VM data lives on the array, so nothing is rebuilt and the 4-node cluster can still ride out one more node failure.",
  cite: ['ntnx-bible-5b', 'ntnx-ahv-admin-11.2', 'ntnx-ncp-everpure-deploy-7.6'],
  status: 'todo',
});
