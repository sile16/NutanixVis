import { defineScenario, type ScenarioDef } from '../define';
import { allRunningAt, at, atCtx, baseInvariants, by, derived, eventSeen, T0 } from '../helpers';
import { nodeId, T3_CO_HCI, T3_CO_SO } from '../ids';

/** Six CO nodes against three HCI nodes (2:1), the inverse of the suggested 1 CO : 2 HCI. */
function coRatio(): ScenarioDef {
  return defineScenario({
    id: 't3-07-co-ratio-advisory',
    title: 'T3 CO+HCI misconfiguration: CO nodes outnumber HCI nodes 2:1',
    topology: T3_CO_HCI.topology,
    options: { 'co-node-count': 6, 'hci-node-count': 3 },
    durationS: T0 + 10,
    timeline: [],
    expect: [
      atCtx(T0, 'an advisory warns about the CO:HCI ratio', (_s, ctx) =>
        eventSeen(ctx, 'cluster.advisory.co-ratio'),
      ),
      allRunningAt(T0, 'it is advisory only: everything runs'),
      ...baseInvariants(),
    ],
    narrative:
      'Six compute-only nodes share the storage of three HCI nodes. Community sizing guidance is about two HCI nodes per CO node, starting with four HCI nodes, so the simulator raises an advisory. It is a warning, not a hard limit, and everything still runs.',
    cite: ['ntnx-community-co-nodes-blog', 'ntnx-community-co-nodes'],
    status: 'active',
  });
}

/** Three SO nodes is the minimum; after one failure the cluster cannot get its FT back. */
function tooFewCvmNodes(): ScenarioDef {
  const END = T0 + 1200;
  return defineScenario({
    id: 't3-07-too-few-cvm-nodes',
    title: 'T3 CO+SO misconfiguration: only three storage-only nodes',
    topology: T3_CO_SO.topology,
    options: { 'so-node-count': 3 },
    durationS: END,
    timeline: [
      {
        at: T0,
        action: { kind: 'power-off', target: nodeId(6) },
        note: 'One of the three SO nodes fails.',
      },
    ],
    expect: [
      at(
        T0,
        'FT1 is met with exactly three CVM nodes',
        (s) => derived(s).nodeFailureTolerance === 1,
      ),
      atCtx(by(0), 'with two CVM nodes left the configured FT cannot be met', (_s, ctx) =>
        eventSeen(ctx, 'cluster.ft.insufficient-nodes'),
      ),
      at(
        END,
        'redundancy cannot be rebuilt on two nodes',
        (s) => derived(s).nodeFailureTolerance === 0 && derived(s).resiliency !== 'OK',
      ),
      ...baseInvariants(),
    ],
    narrative:
      'The cluster has exactly three storage-only nodes, the minimum for FT1, and needs at least three functioning nodes at all times. When one fails, only two CVM-bearing nodes remain, so the cluster cannot restore its configured fault tolerance however long Curator runs. Size CVM nodes for the FT you need plus a spare.',
    cite: ['ntnx-ahv-admin-11.2', 'ntnx-bible-4i'],
    status: 'active',
  });
}

export default [coRatio(), tooFewCvmNodes()];
