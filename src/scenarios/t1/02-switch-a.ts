import { defineScenario } from '../define';
import {
  allCvms,
  allVms,
  alwaysFrom,
  at,
  baseInvariants,
  by,
  faInterfacesBehind,
  hosts,
  isRunning,
  neverSeen,
  onlyPathsLostTo,
  SLACK,
  T0,
  t1Steady,
  vswitch,
} from '../helpers';
import { SW_A, T1 } from '../ids';
import { KATO, PATH_LOSS_WORST } from '../timers';

const END = by(PATH_LOSS_WORST) + 60;

export default defineScenario({
  id: 't1-02-switch-a-fails',
  title: 'T1: storage switch A fails',
  topology: T1.topology,
  durationS: END,
  timeline: [{ at: T0, action: { kind: 'switch.fail', target: SW_A }, note: 'Switch A fails.' }],
  expect: [
    ...t1Steady(),
    at(by(0), 'every vs1 bond is down to its Switch B member', (s) =>
      T1.nodes.every((n) => vswitch(s, T1.storageVs(n)).activeMembers === 1),
    ),
    at(by(KATO), 'every CVM loses exactly the paths to FA ports on Switch A', (s) =>
      allCvms(s, (c) => onlyPathsLostTo(c, faInterfacesBehind(s, SW_A))),
    ),
    alwaysFrom(T0, 'VMs keep running (latency outliers only)', (s) => allVms(s, isRunning)),
    alwaysFrom(T0, 'no command waits longer than KATO + CQT', (s) =>
      allVms(s, (v) => v.ioPendingS <= PATH_LOSS_WORST + SLACK),
    ),
    alwaysFrom(T0, 'no host is disconnected (vs0 fails over too)', (s) =>
      hosts(s).every((h) => h.haState === 'connected'),
    ),
    neverSeen(END, 'ha.vm.restarted'),
    ...baseInvariants(),
  ],
  narrative:
    'Switch A fails. With isolated A/B storage VLANs every path on VLAN 10 runs through Switch A, so each CVM loses those two paths one keep-alive timeout later; the CVM never sees the carrier loss itself. New IO moves to the VLAN-B paths at once and in-flight commands are retried after the quiesce time. vs0 fails over to Switch B, so no host is lost and no HA event follows.',
  cite: [
    'everpure-nutanix-net-bp',
    'ntnx-ncp-everpure-deploy-7.6',
    'everpure-ha-scenarios',
    'everpure-ana-faq',
    'nvme-base-spec',
  ],
  // todo until the workload issues at least one IO per NVMe path per tick (src/domain/workload/io.ts:
  // 2 reads + 2 writes, queue depth 32): with 1 + 1 a tick's two IOs can both land on the
  // silently lost paths, so the VM reads io-stalled for that tick although IO is flowing.
  status: 'todo',
});
