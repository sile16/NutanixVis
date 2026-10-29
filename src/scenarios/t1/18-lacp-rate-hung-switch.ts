import { defineScenario, type ScenarioDef } from '../define';
import {
  allCvms,
  allVms,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  before,
  by,
  eventSeen,
  faInterfacesBehind,
  isRunning,
  onlyPathsLostTo,
  SLACK,
  T0,
  t1Steady,
  vms,
  vswitch,
  wasEver,
} from '../helpers';
import { SW_B, T1 } from '../ids';
import { KATO, P, PATH_LOSS_RULE, PATH_LOSS_WORST } from '../timers';

function variant(rate: 'fast' | 'slow'): ScenarioDef {
  const detect = rate === 'fast' ? P.bond.lacpFastDetectS : P.bond.lacpSlowDetectS;
  // Slow rate: IO queues hashed onto the hung member hit the NVMe IO timeout, which resets their
  // path; one reset just before the detach still needs its reconnect.
  const settled =
    Math.max(detect, KATO) +
    P.externalStorage.reconnectDelayS +
    (rate === 'slow' ? P.externalStorage.ioTimeoutS : 0);
  const END = by(settled) + 30;
  return defineScenario({
    id: `t1-18-lacp-${rate}-hung-switch`,
    title: `T1: LACP ${rate} rate with a hung switch (no carrier loss)`,
    topology: T1.topology,
    options: {
      'vlan-placement': 'tagged-both',
      // The bond can only save a path if the ISL carries the storage VLANs.
      'isl-storage-vlans': 'allowed',
      'vs1-bond-mode': 'balance-tcp',
      mlag: true,
      'lacp-rate': rate,
    },
    durationS: END,
    timeline: [
      {
        at: T0,
        // Switch B, not A: every host's vs0 (mgmt, Active-Backup per DEPLOY-GUIDE Table 2) runs
        // on its Switch A uplink, and Active-Backup cannot detect a hang (SPEC §5.3), so hanging
        // Switch A would also blackhole all cluster traffic and lose ZK quorum. That is a
        // different lesson (T1-20); this scenario isolates the vs1 LACP rate.
        action: { kind: 'switch.hang', target: SW_B },
        note: 'Switch B stops forwarding but its ports keep carrier.',
      },
    ],
    expect: [
      ...t1Steady(),
      at(before(detect), 'bonds still count the Switch B member as up', (s) =>
        T1.nodes.every((n) => vswitch(s, T1.storageVs(n)).activeMembers === 2),
      ),
      atCtx(
        by(detect),
        'LACP detaches the Switch B member',
        (s, ctx) =>
          T1.nodes.every((n) => vswitch(s, T1.storageVs(n)).activeMembers === 1) &&
          eventSeen(ctx, 'net.bond.lacp-timeout'),
      ),
      at(by(settled), 'in the end only the paths to FA ports on Switch B are lost', (s) =>
        allCvms(s, (c) => onlyPathsLostTo(c, faInterfacesBehind(s, SW_B))),
      ),
      alwaysFrom(T0, 'vs0 is untouched: management stays on the Switch A uplinks', (s) =>
        T1.nodes.every((n) => vswitch(s, `node-${n}.vs0`).activeMember === `node-${n}.eth0`),
      ),
      at(by(settled), 'all VMs are running', (s) => allVms(s, isRunning)),
      ...(rate === 'fast'
        ? [
            alwaysFrom(T0, `no command waits longer than detection or ${PATH_LOSS_RULE}`, (s) =>
              allVms(s, (v) => v.ioPendingS <= Math.max(detect, PATH_LOSS_WORST) + SLACK),
            ),
          ]
        : [
            atCtx(
              by(detect),
              'flows hashed to the hung member blackholed far longer than fast rate allows',
              (_s, ctx) =>
                wasEver(
                  ctx,
                  (s) =>
                    vms(s).some(
                      (v) =>
                        v.ioPendingS > Math.max(P.bond.lacpFastDetectS, PATH_LOSS_WORST) + SLACK,
                    ),
                  T0,
                ),
            ),
          ]),
      ...baseInvariants(),
    ],
    narrative:
      rate === 'fast'
        ? 'Switch B hangs without dropping carrier, so only LACP can notice. At the fast rate the vs1 bonds stop receiving LACP PDUs and detach the Switch B member within about 3 s, before any keep-alive timeout, so connections hashed onto it recover on eth1. The paths to the FA ports behind Switch B are lost after the keep-alive timeout, and IO continues on Switch A. Management on vs0 is untouched because its active uplinks are on Switch A: Active-Backup cannot detect a hang, so a hung Switch A would have cut the cluster apart.'
        : 'Switch B hangs without dropping carrier, and the host bonds run the slow LACP rate, which can only be set outside Prism (Prism Active-Active always uses fast, and a slow rate on the switch alone would still leave the host detecting in about 3 s). At the slow rate LACP takes up to 90 s to detach the member, and until then every TCP connection hashed onto it, including IO queues of paths whose keep-alive still gets through, is blackholed. Those commands wait for the NVMe IO timeout, which resets their path so it reconnects on fresh connections, far longer than at the fast rate, which is why the fast rate is the default.',
    cite: ['ntnx-ahv-admin-11.2', 'ovs-bonding', 'nvme-base-spec'],
    status: 'active',
  });
}

export default [variant('fast'), variant('slow')];
