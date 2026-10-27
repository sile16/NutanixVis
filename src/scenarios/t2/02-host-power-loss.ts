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
import { P } from '../timers';

const HA = P.ahvHa;
const LOST = nodeId(2);
const DETACH = P.cluster.cassandraRingDetachS;
const END = by(DETACH) + 60;

export default defineScenario({
  id: 't2-02-host-power-loss',
  title: 'T2: host power loss (fence T+60, restart T+120, rebuild, ring detach at 30 min)',
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
    atCtx(by(P.hci.rebuildStartDelayS), 'rebuild starts immediately', (_s, ctx) =>
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
      END,
      'rebuild has restored full redundancy on the remaining three nodes',
      (s) => derived(s).resiliency === 'OK' && derived(s).underReplicated === 0,
    ),
    ...baseInvariants(),
  ],
  narrative:
    "Node 2 loses power. Curator starts re-replicating its extent groups immediately, spread across the surviving nodes. AHV HA follows its timeline: the 40 s timeout starts at T+20, the host's IO is fenced at T+60, and its VMs restart elsewhere by T+120. After 30 minutes down, CVM 2 is detached from the Cassandra metadata ring.",
  cite: ['ntnx-bible-5b', 'ntnx-bible-4i', 'ntnx-kb-1256', 'ntnx-ahv-admin-11.2'],
  status: 'todo',
});
