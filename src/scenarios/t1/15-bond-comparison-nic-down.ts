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
  SLACK,
  T0,
  t1Steady,
  vm,
  vmsOfNode,
  vswitch,
} from '../helpers';
import { T1, vmId } from '../ids';
import { PATH_LOSS_WORST } from '../timers';

type Mode = 'active-backup' | 'balance-slb' | 'balance-tcp';

const END = by(PATH_LOSS_WORST) + 30;

function variant(mode: Mode): ScenarioDef {
  const describe: Record<Mode, string> = {
    'active-backup': 'Active-Backup moves all traffic to the standby uplink on carrier loss.',
    'balance-slb': 'MAC pinning re-pins the vNICs that were on eth2 to eth3 on carrier loss.',
    'balance-tcp':
      'LACP drops eth2 from the aggregate on carrier loss and rehashes its flows onto eth3.',
  };
  return defineScenario({
    id: `t1-15-bond-nic-down-${mode}`,
    title: `T1 bond comparison: one node NIC down under ${mode}`,
    topology: T1.topology,
    options: {
      'vs1-bond-mode': mode,
      ...(mode === 'balance-tcp' ? { mlag: true } : {}),
    },
    durationS: END,
    timeline: [
      { at: T0, action: { kind: 'fail', target: T1.storageNicA(1) }, note: 'Node 1 eth2 fails.' },
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
      alwaysFrom(T0, 'no NVMe path is lost: the bond keeps both VLANs reachable', (s) =>
        allPathsLive(cvm(s, 1)),
      ),
      neverSeen(END, 'nvme.path.lost'),
      alwaysFrom(T0, 'the blip is at most a couple of ticks', (s) =>
        vmsOfNode(s, 1).every((v) => v.ioPendingS <= SLACK),
      ),
      ...baseInvariants(),
    ],
    narrative: `${describe[mode]} Both storage VLANs are trunked on Switch B, so the CVM's TCP connections survive and no NVMe path is lost; VM IO blips for at most a moment and all load now runs over one uplink.`,
    cite: ['ntnx-ahv-admin-11.2', 'everpure-nutanix-net-bp', 'nvme-base-spec'],
    status: 'active',
  });
}

export default [variant('active-backup'), variant('balance-slb'), variant('balance-tcp')];
