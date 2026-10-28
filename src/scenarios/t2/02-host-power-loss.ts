import { defineScenario } from '../define';
import {
  allRunningAt,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  before,
  by,
  cvm,
  derived,
  eventSeen,
  host,
  isRunning,
  T0,
  vmsOfNode,
  wasEver,
} from '../helpers';
import { cvmId, nodeId, T2 } from '../ids';
import { NODE_REBUILD_START, nodeRebuildS, P, STARGATE_DOWN } from '../timers';

const HA = P.ahvHa;
const LOST = nodeId(2);
const DETACH = P.cluster.cassandraRingDetachS;
/**
 * Rebuild timing (SPEC §6.3 "Curator rebuild", Bible 4i). Node 2's Stargate is declared down when
 * its ZK session expires (`hci.stargateDownDetectS`), and Curator starts `hci.rebuildStartDelayS`
 * later. It then re-copies node 2's share of the used capacity over the three survivors at
 * `hci.rebuildGiBpsPerNode` each. The rate and fill are `assumption`s, so the expectation tracks
 * them rather than a fixed time: with the defaults the copy takes about 64 min, so the 30 min ring
 * detach happens while the rebuild is still running.
 */
const { lostGiB: LOST_GIB, seconds: REBUILD_S } = nodeRebuildS(
  T2.topology,
  LOST,
  T2.nodes.length - 1,
);
const REBUILD_AT = T0 + NODE_REBUILD_START;
/** ±10 % around the modeled duration: catches a stalled rebuild and one not limited by the rate. */
const REBUILDING_UNTIL = REBUILD_AT + Math.floor(REBUILD_S * 0.9);
const REBUILT_BY = REBUILD_AT + Math.ceil(REBUILD_S * 1.1);
const END = Math.max(by(DETACH) + 60, REBUILT_BY);

export default defineScenario({
  id: 't2-02-host-power-loss',
  title: 'T2: host power loss (fence T+60, restart T+120, ring detach at 30 min, rebuild)',
  topology: T2.topology,
  durationS: END,
  timeline: [{ at: T0, action: { kind: 'power-off', target: LOST }, note: 'Node 2 loses power.' }],
  expect: [
    allRunningAt(T0, 'steady state: all VMs running'),
    at(
      T0,
      'node 2 is not the Acropolis leader (see t2-04)',
      (s) => derived(s).acropolisLeader !== LOST,
    ),
    atCtx(
      before(NODE_REBUILD_START),
      'no rebuild before node 2 is declared down plus the start delay',
      (_s, ctx) => !eventSeen(ctx, 'curator.rebuild.start'),
    ),
    atCtx(by(NODE_REBUILD_START), 'rebuild starts 60 s after node 2 is declared down', (_s, ctx) =>
      eventSeen(ctx, 'curator.rebuild.start'),
    ),
    at(
      before(HA.fenceAtS),
      'node 2 not fenced before T+60',
      (s) => host(s, LOST).haState !== 'fenced',
    ),
    at(by(HA.fenceAtS), 'node 2 fenced by T+60', (s) => host(s, LOST).haState === 'fenced'),
    at(before(HA.fenceAtS), 'node 2 VMs not running anywhere before the fence', (s) =>
      vmsOfNode(s, 2).every((v) => !isRunning(v)),
    ),
    at(by(HA.restartByS), 'node 2 VMs restarted on surviving hosts by T+120', (s) =>
      vmsOfNode(s, 2).every((v) => isRunning(v) && v.host !== LOST),
    ),
    atCtx(by(HA.restartByS), 'HA status went through Healing', (_s, ctx) =>
      wasEver(ctx, (s) => derived(s).haStatus === 'Healing', T0),
    ),
    alwaysFrom(
      T0,
      'storage stays available (one failure on FT1)',
      (s) => derived(s).zkQuorum && derived(s).metadataAvailable && derived(s).dataAvailable,
    ),
    at(
      before(DETACH),
      'CVM 2 is still in the Cassandra ring before 30 min',
      (s) => cvm(s, 2).ringState !== 'detached',
    ),
    atCtx(
      by(DETACH),
      'CVM 2 is detached from the ring at 30 min',
      (s, ctx) =>
        cvm(s, 2).ringState === 'detached' &&
        eventSeen(ctx, 'cassandra.node.detached', { device: cvmId(2) }),
    ),
    at(
      by(DETACH),
      'the ring detach happens while the rebuild is still running',
      (s) => derived(s).resiliency === 'Rebuilding' && derived(s).underReplicated > 0,
    ),
    at(
      REBUILDING_UNTIL,
      'rebuild is rate-limited: still running at 90% of data ÷ (rate × 3 survivors)',
      (s) => derived(s).resiliency === 'Rebuilding' && derived(s).underReplicated > 0,
    ),
    atCtx(
      REBUILT_BY,
      'rebuild has restored full redundancy on the remaining three nodes',
      (s, ctx) =>
        derived(s).resiliency === 'OK' &&
        derived(s).underReplicated === 0 &&
        eventSeen(ctx, 'curator.rebuild.complete'),
    ),
    ...baseInvariants(),
  ],
  narrative: `Node 2 loses power, and AHV HA follows its timeline: the 40 s timeout starts at T+20, the host's IO is fenced at T+60, and its VMs restart elsewhere by T+120. The cluster declares node 2's Stargate down when its Zookeeper session expires after ${STARGATE_DOWN} s, and Curator starts re-replicating node 2's extent groups ${P.hci.rebuildStartDelayS} s later, spread across the three surviving nodes. The copy time follows from the data node 2 held and the rebuild rate, both modeled assumptions: about ${(LOST_GIB / 1024).toFixed(1)} TiB at ${P.hci.rebuildGiBpsPerNode} GiB/s per node, roughly ${Math.round(REBUILD_S / 60)} min. After 30 minutes down, while the rebuild is still running, CVM 2 is detached from the Cassandra metadata ring.`,
  cite: [
    'ntnx-bible-5b',
    'ntnx-bible-4i',
    'ntnx-kb-1256',
    'ntnx-ahv-admin-11.2',
    'ntnx-kb-io-freeze-cvm-down',
    'ntnx-kb-delayed-rebuild',
  ],
  status: 'active',
});
