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
/**
 * Nodes 1 and 3 hold two of the three Zookeeper seats (the lowest node ids), so nodes 2 and 4
 * have no ZK majority until those seats' service volumes are mounted elsewhere, which happens
 * only after `serviceVolumeMigrationDelayS` (PowerStore deployment guide 7.6, `inferred` for
 * FlashArray). Only then is a leader elected on node 2, and it starts the HA host timeline from
 * its own election: disconnected at once, fenced `disconnectTimeoutS` later, VMs restarted
 * `restartByS − fenceAtS` after the fence. The isolated VMs, whose IO has failed since the hang,
 * self-terminate as soon as that leader sees their hosts cut off.
 */
const MIGRATE = P.cluster.serviceVolumeMigrationDelayS;
const FENCE = MIGRATE + HA.disconnectTimeoutS;
const RESTART = FENCE + HA.restartByS - HA.fenceAtS;
const END = by(RESTART) + 20;
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
    at(by(0), 'nodes 1 and 3 hold two ZK seats: no side has a ZK majority', (s) =>
      T1.nodes.every((n) => !cvm(s, n).zkQuorum),
    ),
    at(before(MIGRATE), 'no ZK majority until the seats move', (s) => !derived(s).zkQuorum),
    at(
      by(MIGRATE),
      'the seats move to node 4: nodes 2 and 4 hold quorum (N−2 of 4); nodes 1 and 3 stay cut off',
      (s) =>
        derived(s).zkQuorum &&
        ON_B.every((n) => cvm(s, n).zkQuorum) &&
        ON_A.every((n) => !cvm(s, n).zkQuorum),
    ),
    at(END, 'the A-side bonds never noticed the hang', (s) =>
      ON_A.every((n) => vswitch(s, `node-${n}.vs0`).activeMember === `node-${n}.eth0`),
    ),
    at(
      by(MIGRATE),
      'a new Acropolis leader is elected on the quorum side',
      (s) => derived(s).acropolisLeader === nodeId(2),
    ),
    at(by(MIGRATE), 'nodes 1 and 3 are marked disconnected', (s) =>
      ON_A.every((n) => host(s, n).haState === 'disconnected'),
    ),
    atCtx(
      before(MIGRATE),
      'no isolated VM self-terminates while no quorum side exists (T1: IO retries)',
      (_s, ctx) => eventsMatching(ctx, 'ha.vm.self-terminated').length === 0,
    ),
    atCtx(
      by(MIGRATE),
      'VMs on nodes 1 and 3 self-terminate once a quorum side sees them cut off',
      (s, ctx) =>
        ON_A.every((n) =>
          vmsOfNode(s, n).every(
            (v) => firstEventAt(ctx, 'ha.vm.self-terminated', { device: v.id }) !== null,
          ),
        ),
    ),
    at(before(FENCE), "not fenced before the new leader's disconnect timeout", (s) =>
      ON_A.every((n) => host(s, n).haState !== 'fenced'),
    ),
    at(by(FENCE), 'nodes 1 and 3 are fenced', (s) =>
      ON_A.every((n) => host(s, n).haState === 'fenced'),
    ),
    at(by(RESTART), 'their VMs run on nodes 2 and 4', (s) =>
      ON_A.every((n) =>
        vmsOfNode(s, n).every(
          (v) => isRunning(v) && v.host !== null && ON_B.map(nodeId).includes(v.host),
        ),
      ),
    ),
    atCtx(by(RESTART), 'every restart comes after that VM self-terminated', (s, ctx) =>
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
    'Each host’s vs0 active member is pinned so that odd hosts use Switch A and even hosts Switch B, and then Switch A hangs with carrier up. Active-backup never notices, so nodes 1 and 3 are each cut off, and because they hold two of the three Zookeeper seats, nodes 2 and 4 have no majority until those service volumes move to node 4 five minutes later. The new Acropolis leader on node 2 then marks the isolated hosts disconnected, their VMs terminate themselves, and AHV HA fences the hosts and restarts the VMs on nodes 2 and 4. Pinning half the hosts to each switch turns a cluster-wide outage into the loss of two hosts once the seats have moved.',
  cite: [
    'ovs-bonding',
    'everpure-nutanix-cfg',
    'ntnx-bible-5b',
    'ntnx-ahv-admin-11.2',
    'ntnx-ncp-powerstore-deploy-7.6',
  ],
  status: 'active',
});
