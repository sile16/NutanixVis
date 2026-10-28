import { defineScenario } from '../define';
import {
  allRunningAt,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  by,
  derived,
  eventSeen,
  isRunning,
  storageAvailable,
  T0,
  vmsOfNode,
} from '../helpers';
import { nodeId, T2 } from '../ids';
import { NODE_REBUILD_START, P } from '../timers';

const HA = P.ahvHa;
const END = by(HA.restartByS) + 30;

export default defineScenario({
  id: 't2-09-ft2-two-concurrent-failures',
  title: 'T2 FT2 (RF3, 5 nodes): two nodes fail at once',
  topology: T2.topology,
  options: { 'replication-factor': 3, 'node-count': 5 },
  durationS: END,
  timeline: [
    { at: T0, action: { kind: 'power-off', target: nodeId(1) }, note: 'Node 1 fails.' },
    { at: T0, action: { kind: 'power-off', target: nodeId(2) }, note: 'Node 2 fails.' },
  ],
  expect: [
    allRunningAt(T0, 'steady state: all VMs running'),
    at(
      T0,
      'FT2: five ZK members, two failures tolerated',
      (s) => derived(s).ftConfigured === 2 && derived(s).nodeFailureTolerance === 2,
    ),
    alwaysFrom(T0, 'ZK (3 of 5), metadata (RF5) and data (RF3) stay available', storageAvailable),
    atCtx(
      by(NODE_REBUILD_START),
      'rebuild starts 60 s after the nodes are declared down',
      (_s, ctx) => eventSeen(ctx, 'curator.rebuild.start'),
    ),
    at(by(HA.restartByS), 'VMs from both nodes restarted on the survivors', (s) =>
      [1, 2].every((n) =>
        vmsOfNode(s, n).every((v) => isRunning(v) && v.host !== nodeId(1) && v.host !== nodeId(2)),
      ),
    ),
    at(
      by(HA.restartByS),
      'no further failure is tolerated now',
      (s) => derived(s).nodeFailureTolerance === 0,
    ),
    ...baseInvariants(),
  ],
  narrative:
    'On an FT2 cluster data has three copies, metadata five, and Zookeeper runs on five nodes. Two nodes fail at once: every extent group and metadata range still has a live majority, so storage stays up. Once both Stargates are declared down (ZK session expiry), Curator starts rebuilding after its start delay, and HA restarts the VMs from both nodes on the remaining three.',
  cite: ['ntnx-bible-4i', 'ntnx-bible-5b'],
  status: 'active',
});
