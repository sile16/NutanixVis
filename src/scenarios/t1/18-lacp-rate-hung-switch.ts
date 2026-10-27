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
import { SW_A, T1 } from '../ids';
import { KATO, P, PATH_LOSS_WORST } from '../timers';

function variant(rate: 'fast' | 'slow'): ScenarioDef {
  const detect = rate === 'fast' ? P.bond.lacpFastDetectS : P.bond.lacpSlowDetectS;
  const settled = Math.max(detect, KATO) + P.externalStorage.reconnectDelayS;
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
        action: { kind: 'switch.hang', target: SW_A },
        note: 'Switch A stops forwarding but its ports keep carrier.',
      },
    ],
    expect: [
      ...t1Steady(),
      at(before(detect), 'bonds still count the Switch A member as up', (s) =>
        T1.nodes.every((n) => vswitch(s, T1.storageVs(n)).activeMembers === 2),
      ),
      atCtx(
        by(detect),
        'LACP detaches the Switch A member',
        (s, ctx) =>
          T1.nodes.every((n) => vswitch(s, T1.storageVs(n)).activeMembers === 1) &&
          eventSeen(ctx, 'net.bond.lacp-timeout'),
      ),
      at(by(settled), 'in the end only the paths to FA ports on Switch A are lost', (s) =>
        allCvms(s, (c) => onlyPathsLostTo(c, faInterfacesBehind(s, SW_A))),
      ),
      at(by(settled), 'all VMs are running', (s) => allVms(s, isRunning)),
      ...(rate === 'fast'
        ? [
            alwaysFrom(T0, 'no command waits longer than detection or KATO + CQT', (s) =>
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
        ? 'Switch A hangs without dropping carrier, so only LACP can notice. At the fast rate the bonds stop receiving LACP PDUs and detach the Switch A member within about 3 s. The paths to the FA ports behind Switch A are lost after the keep-alive timeout, and IO continues on Switch B.'
        : 'Switch A hangs without dropping carrier. At the slow rate LACP takes up to 90 s to detach the member, and until then every TCP connection hashed onto it, including IO queues of paths whose keep-alive still gets through, is blackholed. Those commands wait far longer than they would at the fast rate, which is why the fast rate is the default.',
    cite: ['ntnx-ahv-admin-11.2', 'ovs-bonding', 'nvme-base-spec'],
    status: 'todo',
  });
}

export default [variant('fast'), variant('slow')];
