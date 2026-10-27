import { defineScenario, type ScenarioDef } from '../define';
import {
  allRunningAt,
  alwaysFrom,
  at,
  baseInvariants,
  before,
  by,
  cvm,
  derived,
  isRunning,
  storageAvailable,
  T0,
  vms,
} from '../helpers';
import { nodeId, T2 } from '../ids';
import { P } from '../timers';

const HA = P.ahvHa;
const FIRST = nodeId(4);
const SECOND = nodeId(3);

/** After the rebuild and the ring detach have both finished, a second failure is survivable. */
function afterRebuild(): ScenarioDef {
  // Wait for both the ring detach (30 min) and the rebuild (data ÷ rate, about 32 min with the
  // default assumptions, see t2-02); the first expectation guards this if those change.
  const SECOND_AT = T0 + P.cluster.cassandraRingDetachS + 600;
  const END = by(HA.restartByS, SECOND_AT) + 30;
  return defineScenario({
    id: 't2-08-second-failure-after-rebuild',
    title: 'T2 FT1: a second node fails after the rebuild has finished',
    topology: T2.topology,
    durationS: END,
    timeline: [
      { at: T0, action: { kind: 'power-off', target: FIRST }, note: 'Node 4 fails.' },
      { at: SECOND_AT, action: { kind: 'power-off', target: SECOND }, note: 'Node 3 fails.' },
    ],
    expect: [
      allRunningAt(T0, 'steady state: all VMs running'),
      at(
        SECOND_AT,
        'before the second failure: rebuilt and node 4 detached',
        (s) => derived(s).resiliency === 'OK' && cvm(s, 4).ringState === 'detached',
      ),
      alwaysFrom(T0, 'storage stays available throughout', storageAvailable),
      at(by(HA.restartByS, SECOND_AT), 'every VM runs on the two surviving nodes', (s) =>
        vms(s).every((v) => isRunning(v) && (v.host === nodeId(1) || v.host === nodeId(2))),
      ),
      at(
        END,
        'the cluster cannot tolerate another failure',
        (s) => derived(s).nodeFailureTolerance === 0,
      ),
      ...baseInvariants(),
    ],
    narrative:
      'Node 4 fails, Curator restores every extent group to two copies on the remaining nodes, and after 30 minutes node 4 is detached from the metadata ring. When node 3 fails later, every piece of data and metadata still has a live majority, so storage stays up and HA restarts the VMs on the last two nodes. The cluster now has no failure tolerance left.',
    cite: ['ntnx-bible-4i', 'ntnx-bible-5b', 'ntnx-kb-1256'],
    status: 'active',
  });
}

/** A second failure while the first rebuild is still running exceeds FT1. */
function duringRebuild(): ScenarioDef {
  const SECOND_AT = T0 + 30;
  const RETURN_AT = SECOND_AT + 600;
  // Node 4's replicas are reachable again once its CVM has booted and Stargate is up
  // (`cluster.cvmBootS`, SPEC §14 #9), not when HA restarts VMs.
  const BACK_BY = by(P.cluster.cvmBootS, RETURN_AT);
  const END = BACK_BY + 30;
  return defineScenario({
    id: 't2-08-second-failure-during-rebuild',
    title: 'T2 FT1: a second node fails while the rebuild is still running',
    topology: T2.topology,
    durationS: END,
    timeline: [
      { at: T0, action: { kind: 'power-off', target: FIRST }, note: 'Node 4 fails.' },
      {
        at: SECOND_AT,
        action: { kind: 'power-off', target: SECOND },
        note: 'Node 3 fails mid-rebuild.',
      },
      { at: RETURN_AT, action: { kind: 'recover', target: FIRST }, note: 'Node 4 comes back.' },
    ],
    expect: [
      allRunningAt(T0, 'steady state: all VMs running'),
      at(
        SECOND_AT,
        'the first rebuild is still in progress',
        (s) => derived(s).resiliency === 'Rebuilding' && derived(s).underReplicated > 0,
      ),
      at(
        by(0, SECOND_AT),
        'beyond FT1: some data or metadata is unavailable',
        (s) => !storageAvailable(s),
      ),
      at(RETURN_AT, 'VMs whose extents are unreachable hang', (s) =>
        vms(s).some((v) => v.ioPendingS > 0),
      ),
      at(
        before(P.cluster.cvmBootS, RETURN_AT),
        "still unavailable while node 4's CVM boots",
        (s) => !storageAvailable(s),
      ),
      at(BACK_BY, 'data was unavailable, not lost: it returns with node 4', storageAvailable),
      at(END, 'and stays available', storageAvailable),
      ...baseInvariants(),
    ],
    narrative:
      'Node 4 fails and Curator starts rebuilding, but node 3 fails before it finishes. Extent groups whose two copies were on nodes 3 and 4, and metadata ranges that lost their majority, become unreachable, and IO to them hangs. The data is unavailable rather than lost: when node 4 returns and its CVM has booted, those replicas are reachable again.',
    cite: ['ntnx-bible-4i', 'ntnx-community-beyond-ft'],
    status: 'active',
  });
}

export default [afterRebuild(), duringRebuild()];
