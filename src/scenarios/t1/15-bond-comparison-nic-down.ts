import { defineScenario, type ScenarioDef } from '../define';
import {
  allPathsLive,
  allVms,
  alwaysFrom,
  at,
  baseInvariants,
  by,
  cvm,
  isRunning,
  neverSeen,
  onlyPathsLostTo,
  SLACK,
  T0,
  t1Steady,
  vm,
  vmsOfNode,
  vswitch,
} from '../helpers';
import { T1, vmId } from '../ids';
import { KATO, PATH_LOSS_RULE, PATH_LOSS_WORST } from '../timers';

type Mode = 'active-backup' | 'balance-slb' | 'balance-tcp';
type Placement = 'tagged-both' | 'strict-ab';

const END = by(PATH_LOSS_WORST) + 30;

function variant(mode: Mode, placement: Placement): ScenarioDef {
  const saved = placement === 'tagged-both';
  const describe: Record<Mode, string> = {
    'active-backup': 'Active-Backup moves all traffic to the standby uplink on carrier loss.',
    'balance-slb': 'MAC pinning re-pins the vNICs that were on eth1 to eth3 on carrier loss.',
    'balance-tcp':
      'LACP drops eth1 from the aggregate on carrier loss and rehashes its flows onto eth3.',
  };
  return defineScenario({
    id: `t1-15-bond-nic-down-${mode}-${placement}`,
    title: `T1 bond comparison: one node NIC down under ${mode} (${saved ? 'VLANs on both switches' : 'isolated A/B VLANs'})`,
    topology: T1.topology,
    options: {
      'vlan-placement': placement,
      ...(placement === 'tagged-both' ? { 'isl-storage-vlans': 'allowed' } : {}),
      'vs1-bond-mode': mode,
      ...(mode === 'balance-tcp' ? { mlag: true } : {}),
    },
    durationS: END,
    timeline: [
      { at: T0, action: { kind: 'fail', target: T1.storageNicA(1) }, note: 'Node 1 eth1 fails.' },
    ],
    expect: [
      ...t1Steady(),
      at(by(0), 'node 1 vs1 carries everything on eth3', (s) => {
        const vs = vswitch(s, T1.storageVs(1));
        return (
          vs.activeMembers === 1 &&
          vm(s, vmId(1, 1)).ioUplinks.every((u) => u === T1.storageNicB(1))
        );
      }),
      alwaysFrom(T0, 'VMs keep running', (s) => allVms(s, isRunning)),
      ...(saved
        ? [
            alwaysFrom(T0, 'no NVMe path is lost: the bond keeps both VLANs reachable', (s) =>
              allPathsLive(cvm(s, 1)),
            ),
            neverSeen(END, 'nvme.path.lost'),
            alwaysFrom(T0, 'the blip is at most a couple of ticks', (s) =>
              vmsOfNode(s, 1).every((v) => v.ioPendingS <= SLACK),
            ),
          ]
        : [
            at(by(KATO), 'node 1 loses its VLAN-A paths after KATO', (s) =>
              onlyPathsLostTo(cvm(s, 1), T1.faIfacesA),
            ),
            alwaysFrom(T0, `no command waits longer than ${PATH_LOSS_RULE}`, (s) =>
              vmsOfNode(s, 1).every((v) => v.ioPendingS <= PATH_LOSS_WORST + SLACK),
            ),
          ]),
      ...baseInvariants(),
    ],
    narrative: saved
      ? `${describe[mode]} Both storage VLANs exist on Switch B, so the CVM's TCP connections survive and no NVMe path is lost; VM IO blips for at most a moment and all load now runs over one uplink.`
      : `${describe[mode]} But Switch B does not carry VLAN 10, so the bond cannot save the VLAN-A paths: they fall silent and are lost one keep-alive timeout later, and IO continues on VLAN B.`,
    cite: ['ntnx-ahv-admin-11.2', 'everpure-nutanix-net-bp', 'nvme-base-spec'],
    // todo until the workload issues at least one IO per NVMe path per tick (src/domain/workload/io.ts:
    // 2 reads + 2 writes, queue depth 32): with 1 + 1 a tick's two IOs can both land on the
    // silently lost paths, so the VM reads io-stalled for that tick although IO is flowing.
    status: 'active',
  });
}

export default [
  variant('active-backup', 'tagged-both'),
  variant('balance-slb', 'tagged-both'),
  variant('balance-tcp', 'tagged-both'),
  variant('balance-slb', 'strict-ab'),
];
