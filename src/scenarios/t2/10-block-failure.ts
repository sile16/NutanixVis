import { defineScenario, type ScenarioDef } from '../define';
import {
  allRunningAt,
  alwaysFrom,
  at,
  baseInvariants,
  before,
  by,
  derived,
  isRunning,
  storageAvailable,
  T0,
  vmsOfNode,
} from '../helpers';
import { nodeId, T2 } from '../ids';
import { P } from '../timers';

const HA = P.ahvHa;
/** `three-blocks` places node n in block ((n − 1) mod 3) + 1, so block 1 is nodes 1 and 4. */
const BLOCK_1 = [1, 4];

function variant(met: boolean): ScenarioDef {
  const nodes = met ? 6 : 4;
  const RETURN_AT = T0 + 300;
  // The block's replicas are reachable again once its CVMs have booted (`cluster.cvmBootS`,
  // SPEC §14 #9); VM restarts by AHV HA are not what brings data back.
  const BACK_BY = by(P.cluster.cvmBootS, RETURN_AT);
  const END = met ? by(HA.restartByS) + 30 : BACK_BY + 30;
  return defineScenario({
    id: `t2-10-block-failure-${met ? 'aware' : 'not-met'}`,
    title: `T2: a whole block fails (block awareness ${met ? 'met' : 'not met'})`,
    topology: T2.topology,
    options: { 'node-count': nodes, 'block-layout': 'three-blocks' },
    durationS: END,
    timeline: [
      ...BLOCK_1.map((n) => ({
        at: T0,
        action: { kind: 'power-off', target: nodeId(n) },
        note: `Block 1 loses power (node ${n}).`,
      })),
      ...(met
        ? []
        : BLOCK_1.map((n) => ({ at: RETURN_AT, action: { kind: 'recover', target: nodeId(n) } }))),
    ],
    expect: [
      allRunningAt(T0, 'steady state: all VMs running'),
      at(
        T0,
        `block awareness is ${met ? 'met' : 'not met'}`,
        (s) => derived(s).blockAwareness === (met ? 'met' : 'not-met'),
      ),
      ...(met
        ? [
            alwaysFrom(
              T0,
              'storage stays available: no two replicas share a block',
              storageAvailable,
            ),
            at(by(HA.restartByS), 'block 1 VMs restarted in the other blocks', (s) =>
              BLOCK_1.every((n) =>
                vmsOfNode(s, n).every(
                  (v) => isRunning(v) && !BLOCK_1.map(nodeId).includes(v.host ?? ''),
                ),
              ),
            ),
          ]
        : [
            at(
              by(0),
              'losing the block exceeds FT1: some data or metadata is unavailable',
              (s) => !storageAvailable(s),
            ),
            at(
              before(P.cluster.cvmBootS, RETURN_AT),
              "still unavailable while the block's CVMs boot",
              (s) => !storageAvailable(s),
            ),
            at(BACK_BY, 'availability returns with the block', storageAvailable),
            at(END, 'and stays available', storageAvailable),
          ]),
      ...baseInvariants(),
    ],
    narrative: met
      ? 'Six nodes sit in three blocks of two, which meets block awareness: no two replicas of any data, metadata or Zookeeper member share a block. A whole block loses power, and the cluster carries on as for a single failure, restarting that block’s VMs in the other two.'
      : 'Four nodes in three blocks put two nodes in block 1, so block awareness is not met and replicas can share a block. When block 1 loses power the cluster loses two nodes at once, beyond FT1, and data or metadata whose copies were both in that block is unavailable until it returns.',
    cite: ['ntnx-bible-4i', 'ntnx-bible-5b'],
    status: 'active',
  });
}

export default [variant(true), variant(false)];
