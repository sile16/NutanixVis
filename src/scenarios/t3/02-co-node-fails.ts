import { defineScenario, type ScenarioDef } from '../define';
import {
  allRunningAt,
  always,
  alwaysFrom,
  at,
  baseInvariants,
  before,
  by,
  derived,
  isRunning,
  neverSeen,
  noVmOnStorageOnly,
  storageAvailable,
  T0,
  vmOnRole,
  vmsOfNode,
} from '../helpers';
import { nodeId, T3_CO_HCI, T3_CO_SO } from '../ids';
import { P } from '../timers';

const HA = P.ahvHa;
const CO = 1;
const END = by(HA.restartByS) + 30;

function variant(mixed: boolean): ScenarioDef {
  const topo = mixed ? T3_CO_HCI : T3_CO_SO;
  const targets = mixed ? (['compute-only', 'hci'] as const) : (['compute-only'] as const);
  return defineScenario({
    id: `t3-02-co-node-fails-${mixed ? 'co-hci' : 'co-so'}`,
    title: `T3 ${mixed ? 'CO+HCI' : 'CO+SO'}: a compute-only node fails`,
    topology: topo.topology,
    durationS: END,
    timeline: [
      { at: T0, action: { kind: 'power-off', target: nodeId(CO) }, note: 'CO node 1 loses power.' },
    ],
    expect: [
      allRunningAt(T0, 'steady state: all VMs running'),
      at(before(HA.fenceAtS), 'node 1 VMs are down until the fence', (s) =>
        vmsOfNode(s, CO).every((v) => !isRunning(v)),
      ),
      at(
        by(HA.restartByS),
        `node 1 VMs restart on ${mixed ? 'a CO or HCI' : 'another CO'} node`,
        (s) =>
          vmsOfNode(s, CO).every(
            (v) => isRunning(v) && v.host !== nodeId(CO) && vmOnRole(s, v, targets),
          ),
      ),
      always('no VM is ever placed on a storage-only node', noVmOnStorageOnly),
      alwaysFrom(
        T0,
        'storage is untouched: a CO node holds no data',
        (s) => storageAvailable(s) && derived(s).resiliency === 'OK',
      ),
      neverSeen(END, 'curator.rebuild.start'),
      ...baseInvariants(),
    ],
    narrative: mixed
      ? 'Compute-only node 1 fails. It holds no data and runs no CVM, so storage is untouched and nothing is rebuilt. AHV HA restarts its VMs by T+120 on the other compute-only node or on an HCI node.'
      : 'Compute-only node 1 fails. It holds no data and runs no CVM, so storage is untouched and nothing is rebuilt. AHV HA restarts its VMs by T+120 on another compute-only node; storage-only nodes are never restart targets.',
    cite: ['ntnx-ahv-admin-11.2', 'ntnx-bible-5b', 'ntnx-community-co-nodes-blog'],
    status: 'todo',
  });
}

export default [variant(false), variant(true)];
