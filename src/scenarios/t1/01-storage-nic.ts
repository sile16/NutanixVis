import { defineScenario, type ScenarioDef } from '../define';
import {
  allCvms,
  allPathsLive,
  allVms,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  by,
  cvm,
  eventSeen,
  isRunning,
  neverSeen,
  onlyPathsLostTo,
  SLACK,
  T0,
  t1Steady,
  vmsOfNode,
  vswitch,
} from '../helpers';
import { cvmId, T1 } from '../ids';
import { KATO, PATH_LOSS_WORST } from '../timers';

const END = by(PATH_LOSS_WORST) + 30;

function variant(placement: 'strict-ab' | 'tagged-both'): ScenarioDef {
  const trunked = placement === 'tagged-both';
  return defineScenario({
    id: `t1-01-storage-nic-${trunked ? 'tagged-both' : 'strict-ab'}`,
    title: `T1: one vs1 storage NIC fails (${trunked ? 'VLANs tagged on both switches' : 'isolated A/B VLANs'})`,
    topology: T1.topology,
    options: {
      'vlan-placement': placement,
      ...(placement === 'tagged-both' ? { 'isl-storage-vlans': 'allowed' } : {}),
    },
    durationS: END,
    timeline: [
      {
        at: T0,
        action: { kind: 'fail', target: T1.storageNicA(1) },
        note: 'Node 1 eth1 (vs1 member to Switch A) fails.',
      },
    ],
    expect: [
      ...t1Steady(),
      atCtx(by(0), 'vs1 on node 1 moves its vNICs to eth3 on carrier loss', (s, ctx) => {
        const vs = vswitch(s, T1.storageVs(1));
        return (
          vs.activeMembers === 1 &&
          Object.values(vs.pinning).every((m) => m === T1.storageNicB(1)) &&
          eventSeen(ctx, 'net.bond.failover', { device: T1.storageVs(1) })
        );
      }),
      alwaysFrom(T0, 'VMs keep running (latency outliers only)', (s) => allVms(s, isRunning)),
      ...(trunked
        ? [
            alwaysFrom(T0, 'node 1 CVM never loses an NVMe path', (s) => allPathsLive(cvm(s, 1))),
            neverSeen(END, 'nvme.path.lost'),
            alwaysFrom(T0, 'node 1 VM IO blip is at most a couple of ticks', (s) =>
              vmsOfNode(s, 1).every((v) => v.ioPendingS <= SLACK),
            ),
          ]
        : [
            at(by(KATO), 'node 1 loses its VLAN-A paths after KATO and keeps VLAN-B', (s) =>
              onlyPathsLostTo(cvm(s, 1), T1.faIfacesA),
            ),
            atCtx(by(KATO), 'path loss is reported on CVM 1', (_s, ctx) =>
              eventSeen(ctx, 'nvme.path.lost', { device: cvmId(1) }),
            ),
            at(by(KATO), 'other CVMs keep every path', (s) =>
              allCvms(s, (c) => c.id === cvmId(1) || allPathsLive(c)),
            ),
            alwaysFrom(T0, 'no command waits longer than KATO + CQT', (s) =>
              allVms(s, (v) => v.ioPendingS <= PATH_LOSS_WORST + SLACK),
            ),
          ]),
      ...baseInvariants(),
    ],
    narrative: trunked
      ? 'Node 1 loses one vs1 uplink. The MAC-pinning bond moves both CVM storage vNICs to eth3 on carrier loss, and because both storage VLANs are tagged on Switch B, the TCP connections survive and NVMe never notices. VM IO sees at most a brief blip.'
      : 'Node 1 loses one vs1 uplink. The bond moves the VLAN-A vNIC to eth3, but Switch B does not carry VLAN 10, so its frames go nowhere. The CVM never sees the carrier loss: its VLAN-A paths fall silent and are declared lost one keep-alive timeout later. New IO moves to the VLAN-B paths at once, and commands caught in flight are held for the quiesce time and retried, so VMs only see a latency spike.',
    cite: [
      'ntnx-ahv-admin-11.2',
      'everpure-nutanix-net-bp',
      'ntnx-ncp-everpure-deploy-7.6',
      'nvme-base-spec',
    ],
    status: 'todo',
  });
}

export default [variant('strict-ab'), variant('tagged-both')];
