import { defineScenario } from '../define';
import {
  allCvms,
  allVms,
  alwaysFrom,
  at,
  baseInvariants,
  by,
  cvmStorageInterfaces,
  faInterfacesBehind,
  isRunning,
  onlyPathsLostTo,
  SLACK,
  T0,
  t1Steady,
} from '../helpers';
import { SW_A, T1 } from '../ids';
import { KATO, PATH_LOSS_WORST } from '../timers';

const END = by(PATH_LOSS_WORST) + 30;

export default defineScenario({
  id: 't1-11-single-vlan-switch-fail',
  title: 'T1 misconfiguration: single storage VLAN, then Switch A fails',
  topology: T1.topology,
  options: { 'storage-vlans': 'single', 'vlan-placement': 'tagged-both' },
  durationS: END,
  timeline: [{ at: T0, action: { kind: 'switch.fail', target: SW_A }, note: 'Switch A fails.' }],
  expect: [
    ...t1Steady(),
    at(
      T0,
      'each CVM has a single storage vNIC carrying all four paths',
      (s) =>
        T1.nodes.every((n) => cvmStorageInterfaces(s, n).length === 1) &&
        allCvms(s, (c) => c.nvmePathsTotal === 4),
    ),
    at(by(KATO), 'every CVM loses the paths to FA ports on Switch A', (s) =>
      allCvms(s, (c) => onlyPathsLostTo(c, faInterfacesBehind(s, SW_A))),
    ),
    alwaysFrom(T0, 'VMs keep running (latency outliers only)', (s) => allVms(s, isRunning)),
    alwaysFrom(T0, 'no command waits longer than KATO + CQT', (s) =>
      allVms(s, (v) => v.ioPendingS <= PATH_LOSS_WORST + SLACK),
    ),
    ...baseInvariants(),
  ],
  narrative:
    "With only one storage VLAN each CVM has one storage vNIC, so all of its NVMe paths share one MAC and one uplink. When Switch A fails that vNIC has to fail over, so every path on a node blips at once instead of half of them riding through on a second VLAN. The paths to the array's Switch A ports are then lost, and IO continues on the two ports behind Switch B.",
  cite: ['everpure-nutanix-net-bp', 'ntnx-ncp-everpure-deploy-7.6', 'ntnx-ahv-admin-11.2'],
  status: 'todo',
});
