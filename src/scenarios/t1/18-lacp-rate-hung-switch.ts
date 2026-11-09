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
  firstEventAt,
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
      'vs1-bond-mode': 'balance-tcp',
      mlag: true,
      'lacp-rate': rate,
    },
    durationS: END,
    timeline: [
      {
        at: T0,
        // vs0 is Active-Active LACP at the fast rate Prism sets, whatever `lacp-rate` says (it
        // applies to vs1), so management detects the hang in about 3 s either way (T1-20); this
        // scenario isolates the vs1 LACP rate.
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
      at(by(P.bond.lacpFastDetectS), 'vs0 (fast LACP) has detached its Switch B member', (s) =>
        T1.nodes.every((n) => vswitch(s, `node-${n}.vs0`).activeMembers === 1),
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
              'before the slow LACP detaches the member, every node goes into Hades maintenance (its connections through Switch B are blackholed, as for a hung member that keeps LACPDUs)',
              (_s, ctx) =>
                T1.nodes.every((n) => {
                  const t = firstEventAt(ctx, 'hades.maintenance.enter', {
                    device: `node-${n}.cvm`,
                  });
                  return t !== null && t < T0 + detect;
                }),
            ),
            atCtx(
              by(settled),
              'with no Stargate left serving, the VMs crash and AHV powers them back on',
              (s, ctx) => vms(s).every((v) => eventSeen(ctx, 'ha.vm.restarted', { device: v.id })),
            ),
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
        ? 'Switch B hangs without dropping carrier, so only LACP can notice. At the fast rate the vs1 bonds stop receiving LACP PDUs and detach the Switch B member within about 3 s, before any keep-alive timeout, so connections hashed onto it recover on eth2. The paths to the FA ports behind Switch B are lost after the keep-alive timeout, and IO continues on Switch A. Management on vs0 runs LACP at the fast rate too, so it detaches the Switch B member in the same few seconds.'
        : "Switch B hangs without dropping carrier, and the host bonds run the slow LACP rate, which can only be set outside Prism (Prism Active-Active always uses fast). LACP takes up to 90 s to detach the member, and until then every connection with either direction through Switch B is blackholed, as with a hung member that keeps sending LACPDUs. The CVMs' IO stops, so every node goes into Hades maintenance before LACP acts, no Stargate is left serving and the VMs crash; AHV powers them back on once LACP has detached the member and the nodes recover. This is why the fast rate is the default.",
    cite: ['ntnx-ahv-admin-11.2', 'ovs-bonding', 'nvme-base-spec'],
    status: 'active',
  });
}

export default [variant('fast'), variant('slow')];
