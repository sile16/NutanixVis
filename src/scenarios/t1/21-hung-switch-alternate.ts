import { defineScenario } from '../define';
import {
  at,
  atCtx,
  baseInvariants,
  before,
  by,
  cvm,
  derived,
  eventsMatching,
  firstEventAt,
  host,
  isRunning,
  neverSeen,
  T0,
  t1Steady,
  vmsOfNode,
  vswitch,
} from '../helpers';
import { nodeId, SW_A, T1 } from '../ids';
import { P } from '../timers';

const HA = P.ahvHa;
const END = by(HA.restartByS) + 20;
/** `alternate`: odd hosts start vs0 on Switch A (eth0), even hosts on Switch B (eth2). */
const ON_A = [1, 3];
const ON_B = [2, 4];

export default defineScenario({
  id: 't1-21-hung-switch-alternate',
  title: 'T1: Switch A hangs; hosts active on it are isolated and HA-fenced',
  topology: T1.topology,
  options: { 'vs0-active-member': 'alternate' },
  durationS: END,
  timeline: [
    {
      at: T0,
      action: { kind: 'switch.hang', target: SW_A },
      note: 'Switch A stops forwarding but keeps carrier on every port.',
    },
  ],
  expect: [
    ...t1Steady(),
    at(T0, 'odd hosts run vs0 on Switch A, even hosts on Switch B', (s) =>
      T1.nodes.every(
        (n) => vswitch(s, `node-${n}.vs0`).activeMember === `node-${n}.eth${n % 2 === 1 ? 0 : 2}`,
      ),
    ),
    at(
      by(0),
      'nodes 2 and 4 keep quorum (N−2 of 4); nodes 1 and 3 are each cut off',
      (s) =>
        derived(s).zkQuorum &&
        ON_B.every((n) => cvm(s, n).zkQuorum) &&
        ON_A.every((n) => !cvm(s, n).zkQuorum),
    ),
    at(END, 'the A-side bonds never noticed the hang', (s) =>
      ON_A.every((n) => vswitch(s, `node-${n}.vs0`).activeMember === `node-${n}.eth0`),
    ),
    at(
      by(HA.leaderReelectionS),
      'a new Acropolis leader is elected on the quorum side',
      (s) => derived(s).acropolisLeader === nodeId(2),
    ),
    at(
      by(Math.max(HA.timeoutStartS, HA.leaderReelectionS)),
      'nodes 1 and 3 are marked disconnected',
      (s) => ON_A.every((n) => host(s, n).haState === 'disconnected'),
    ),
    atCtx(
      before(HA.isolatedVmSelfTerminateS),
      'no isolated VM self-terminates before 45 s',
      (_s, ctx) => eventsMatching(ctx, 'ha.vm.self-terminated').length === 0,
    ),
    atCtx(
      by(HA.isolatedVmSelfTerminateS),
      'VMs on nodes 1 and 3 self-terminate 45 s after their first failed IO',
      (s, ctx) =>
        ON_A.every((n) =>
          vmsOfNode(s, n).every(
            (v) => firstEventAt(ctx, 'ha.vm.self-terminated', { device: v.id }) !== null,
          ),
        ),
    ),
    at(before(HA.fenceAtS), 'not fenced before T+60', (s) =>
      ON_A.every((n) => host(s, n).haState !== 'fenced'),
    ),
    at(by(HA.fenceAtS), 'nodes 1 and 3 are fenced by T+60', (s) =>
      ON_A.every((n) => host(s, n).haState === 'fenced'),
    ),
    at(by(HA.restartByS), 'their VMs run on nodes 2 and 4 by T+120', (s) =>
      ON_A.every((n) =>
        vmsOfNode(s, n).every(
          (v) => isRunning(v) && v.host !== null && ON_B.map(nodeId).includes(v.host),
        ),
      ),
    ),
    atCtx(by(HA.restartByS), 'every restart comes after that VM self-terminated', (s, ctx) =>
      ON_A.every((n) =>
        vmsOfNode(s, n).every((v) => {
          const died = firstEventAt(ctx, 'ha.vm.self-terminated', { device: v.id });
          const back = firstEventAt(ctx, 'ha.vm.restarted', { device: v.id });
          return died !== null && back !== null && back > died;
        }),
      ),
    ),
    at(END, 'VMs on nodes 2 and 4 never left their hosts', (s) =>
      ON_B.every((n) => vmsOfNode(s, n).every((v) => isRunning(v) && v.host === nodeId(n))),
    ),
    ...ON_B.map((n) => neverSeen(END, 'ha.host.disconnected', { device: nodeId(n) })),
    ...baseInvariants(),
  ],
  narrative:
    'Each host’s vs0 active member is pinned so that odd hosts use Switch A and even hosts Switch B, and then Switch A hangs with carrier up. Active-backup never notices, so nodes 1 and 3 are each cut off, while nodes 2 and 4 still reach each other through Switch B and keep quorum. The new Acropolis leader on node 2 marks the isolated hosts disconnected and fences them at T+60, their VMs terminate themselves 45 s after their first failed IO, and AHV HA restarts them on nodes 2 and 4 by T+120. Pinning half the hosts to each switch turns a cluster-wide outage into the loss of two hosts.',
  cite: ['ovs-bonding', 'everpure-nutanix-cfg', 'ntnx-bible-5b', 'ntnx-ahv-admin-11.2'],
  status: 'active',
});
