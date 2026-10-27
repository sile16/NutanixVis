import { defineScenario } from '../define';
import {
  allRunningAt,
  at,
  atCtx,
  baseInvariants,
  before,
  by,
  firstEventAt,
  host,
  isRunning,
  T0,
  vmOnRole,
  vmsOfNode,
} from '../helpers';
import { nodeId, T3_CO_SO } from '../ids';
import { P } from '../timers';

const HA = P.ahvHa;
const CO = 1;
const END = by(HA.restartByS) + 30;

export default defineScenario({
  id: 't3-04-co-all-uplinks-lost',
  title: 'T3 CO+SO: a CO node loses all uplinks',
  topology: T3_CO_SO.topology,
  durationS: END,
  timeline: [
    { at: T0, action: { kind: 'fail', target: T3_CO_SO.nicA(CO) }, note: 'CO node 1 eth0 fails.' },
    { at: T0, action: { kind: 'fail', target: T3_CO_SO.nicB(CO) }, note: 'CO node 1 eth1 fails.' },
  ],
  expect: [
    allRunningAt(T0, 'steady state: all VMs running'),
    at(by(0), 'storage IO stops at once: there is no local CVM', (s) =>
      vmsOfNode(s, CO).every((v) => !isRunning(v) && v.readPendingS > 0),
    ),
    atCtx(
      before(HA.isolatedVmSelfTerminateS),
      'no self-termination before 45 s',
      (_s, ctx) => firstEventAt(ctx, 'ha.vm.self-terminated') === null,
    ),
    atCtx(
      by(HA.isolatedVmSelfTerminateS),
      'isolated VMs self-terminate 45 s after the first failed IO',
      (s, ctx) =>
        vmsOfNode(s, CO).every(
          (v) => firstEventAt(ctx, 'ha.vm.self-terminated', { device: v.id }) !== null,
        ),
    ),
    at(by(HA.fenceAtS), 'node 1 is fenced', (s) => host(s, CO).haState === 'fenced'),
    at(by(HA.restartByS), 'its VMs restart on another CO node', (s) =>
      vmsOfNode(s, CO).every(
        (v) => isRunning(v) && v.host !== nodeId(CO) && vmOnRole(s, v, ['compute-only']),
      ),
    ),
    ...baseInvariants(),
  ],
  narrative:
    'Compute-only node 1 loses both uplinks. Its VMs reach storage only over the network, so their IO stops immediately, unlike an HCI VM, which could still read from its local CVM. The cluster then treats the host as isolated: the VMs terminate themselves 45 s after their first failed IO, the host is fenced, and HA restarts them on another compute-only node.',
  cite: ['ntnx-ahv-admin-11.2', 'ntnx-bible-5b', 'ntnx-community-co-nodes'],
  status: 'todo',
});
