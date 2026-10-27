import { defineScenario } from '../define';
import { allRunningAt, at, baseInvariants, by, isRunning, T0, vmsOfNode } from '../helpers';
import { nodeId, T3_CO_HCI } from '../ids';
import { P } from '../timers';

const HA = P.ahvHa;
const CO = 1;
const HCI = 3;
const END = by(HA.restartByS) + 30;

export default defineScenario({
  id: 't3-05-hci-vs-co-nic-failure',
  title: 'T3 CO+HCI: the same NIC failure on an HCI node and a CO node',
  topology: T3_CO_HCI.topology,
  // One uplink per node (No Uplink Bond), so a NIC failure takes the node off the network.
  options: { 'vs0-bond-mode': 'no-bond' },
  durationS: END,
  timeline: [
    { at: T0, action: { kind: 'fail', target: T3_CO_HCI.nicA(CO) }, note: 'CO node 1 eth0 fails.' },
    {
      at: T0,
      action: { kind: 'fail', target: T3_CO_HCI.nicA(HCI) },
      note: 'HCI node 3 eth0 fails.',
    },
  ],
  expect: [
    allRunningAt(T0, 'steady state: all VMs running'),
    at(by(0), 'HCI VM reads keep flowing to the local CVM', (s) =>
      vmsOfNode(s, HCI).every((v) => v.readPendingS === 0 && v.host === nodeId(HCI)),
    ),
    at(by(0), 'HCI VM writes cannot reach a remote replica', (s) =>
      vmsOfNode(s, HCI).every((v) => v.writePendingS > 0),
    ),
    at(by(0), 'CO VM reads and writes both stop', (s) =>
      vmsOfNode(s, CO).every((v) => v.readPendingS > 0 && v.writePendingS > 0),
    ),
    at(
      by(HA.restartByS),
      'both nodes are then handled as isolated hosts: VMs restart elsewhere',
      (s) =>
        [CO, HCI].every((n) => vmsOfNode(s, n).every((v) => isRunning(v) && v.host !== nodeId(n))),
    ),
    ...baseInvariants(),
  ],
  narrative:
    "The same NIC fails on HCI node 3 and on compute-only node 1, each running without an uplink bond. On the HCI node, VM reads keep flowing to the local CVM over the host's internal bridge; only writes, which need a remote replica, stall. On the CO node every IO crosses the failed NIC, so reads and writes stop at once. Both nodes then follow the isolation path, and HA restarts their VMs elsewhere.",
  cite: ['ntnx-ahv-admin-11.2', 'ntnx-bible-5b', 'ntnx-bible-4g', 'ntnx-community-co-nodes'],
  status: 'todo',
});
