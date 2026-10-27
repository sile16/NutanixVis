import type { ScenarioStep } from '../define';
import { defineScenario } from '../define';
import {
  allRunningAt,
  at,
  atCtx,
  baseInvariants,
  before,
  by,
  cvm,
  firstEventAt,
  host,
  isRunning,
  T0,
  vmsOfNode,
} from '../helpers';
import { ISL, nodeId, T2 } from '../ids';
import { P } from '../timers';

const HA = P.ahvHa;
const MAJORITY = [1, 2, 3];
const MINORITY = [4, 5];
const END = by(HA.restartByS) + 30;

/** Nodes 1–3 only on Switch A, nodes 4–5 only on Switch B, ISL down: a clean 3/2 split. */
const split: ScenarioStep[] = [
  { at: T0, action: { kind: 'link-down', target: ISL }, note: 'The ISL goes down.' },
  ...MAJORITY.map((n) => ({ at: T0, action: { kind: 'link-down', target: T2.linkB(n) } })),
  ...MINORITY.map((n) => ({ at: T0, action: { kind: 'link-down', target: T2.linkA(n) } })),
];

export default defineScenario({
  id: 't2-11-partition-3-2',
  title: 'T2: a 3/2 network partition on a 5-node cluster',
  topology: T2.topology,
  options: { 'replication-factor': 3, 'node-count': 5 },
  durationS: END,
  timeline: split,
  expect: [
    allRunningAt(T0, 'steady state: all VMs running'),
    at(
      by(0),
      'only the three-node side has ZK quorum',
      (s) =>
        MAJORITY.every((n) => cvm(s, n).zkQuorum) && MINORITY.every((n) => !cvm(s, n).zkQuorum),
    ),
    at(by(HA.fenceAtS), 'the minority hosts are fenced', (s) =>
      MINORITY.every((n) => host(s, n).haState === 'fenced'),
    ),
    at(before(HA.isolatedVmSelfTerminateS), 'minority VMs have not self-terminated yet', (s) =>
      MINORITY.every((n) => vmsOfNode(s, n).every((v) => v.host === nodeId(n))),
    ),
    at(by(HA.restartByS), 'minority VMs run on the majority side', (s) =>
      MINORITY.every((n) =>
        vmsOfNode(s, n).every((v) => isRunning(v) && MAJORITY.map(nodeId).includes(v.host ?? '')),
      ),
    ),
    atCtx(by(HA.restartByS), 'each minority VM self-terminated before its restart', (s, ctx) =>
      MINORITY.every((n) =>
        vmsOfNode(s, n).every((v) => {
          const died = firstEventAt(ctx, 'ha.vm.self-terminated', { device: v.id });
          const back = firstEventAt(ctx, 'ha.vm.restarted', { device: v.id });
          return died !== null && back !== null && back > died;
        }),
      ),
    ),
    at(by(HA.restartByS), 'majority VMs never moved', (s) =>
      MAJORITY.every((n) => vmsOfNode(s, n).every((v) => isRunning(v) && v.host === nodeId(n))),
    ),
    ...baseInvariants(),
  ],
  narrative:
    'The network splits a five-node FT2 cluster into three nodes and two. Only the three-node side holds a Zookeeper majority, so it keeps the cluster running, fences the other two hosts and restarts their VMs. On the two-node side writes fail, and each VM terminates itself 45 s after its first failed IO, so it is gone before its restarted copy starts.',
  cite: ['ntnx-bible-5b', 'ntnx-bible-4i'],
  status: 'active',
});
