import { defineScenario } from '../define';
import {
  allCvms,
  allVms,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  by,
  derived,
  eventsMatching,
  faInterfacesBehind,
  hosts,
  neverSeen,
  onlyPathsLostTo,
  T0,
  t1Steady,
  vms,
  vswitch,
} from '../helpers';
import { SW_A, T1 } from '../ids';
import { KATO } from '../timers';

/**
 * The admin powers Switch A off 50 s after it hangs, before the 60 s Linux guest SCSI timeout
 * (AHV Admin Guide 11.2) would turn the stalled writes into guest IO errors.
 */
const POWER_OFF = T0 + 50;
const END = by(30, POWER_OFF);
const vs0 = (n: number): string => `node-${n}.vs0`;

export default defineScenario({
  id: 't1-20-hung-switch-vs0',
  title: 'T1: Switch A hangs with carrier up; every host is active on it',
  topology: T1.topology,
  // OVS default: each host's active-backup vs0 starts on eth0, which is cabled to Switch A.
  options: { 'vs0-active-member': 'first' },
  durationS: END,
  timeline: [
    {
      at: T0,
      action: { kind: 'switch.hang', target: SW_A },
      note: 'Switch A stops forwarding but keeps carrier on every port.',
    },
    {
      at: POWER_OFF,
      action: { kind: 'switch.fail', target: SW_A },
      note: 'The admin powers Switch A off: carrier drops, so the bonds fail over.',
    },
  ],
  expect: [
    ...t1Steady(),
    at(T0, 'every vs0 starts on its Switch A member (eth0)', (s) =>
      T1.nodes.every((n) => vswitch(s, vs0(n)).activeMember === `node-${n}.eth0`),
    ),
    at(by(0), 'CVMs cannot reach each other over vs0: Zookeeper quorum is lost', (s) => {
      const d = derived(s);
      return !d.zkQuorum && d.clusterServices === 'down';
    }),
    at(by(KATO), 'the NVMe paths through Switch B stay live; only VLAN-A paths are lost', (s) =>
      allCvms(s, (c) => onlyPathsLostTo(c, faInterfacesBehind(s, SW_A))),
    ),
    alwaysFrom(T0, 'until the power-off no vs0 bond notices anything', (s) =>
      s.simTime > POWER_OFF
        ? true
        : T1.nodes.every((n) => vswitch(s, vs0(n)).activeMember === `node-${n}.eth0`),
    ),
    atCtx(POWER_OFF, 'no bond event on any vs0 while the switch is hung', (_s, ctx) =>
      T1.nodes.every((n) =>
        eventsMatching(ctx, 'net.bond.failover', { device: vs0(n) }).every((e) => e.t > POWER_OFF),
      ),
    ),
    at(POWER_OFF, 'every VM has had writes stalled since the hang', (s) =>
      allVms(s, (v) => v.writePendingS >= POWER_OFF - T0 - KATO),
    ),
    alwaysFrom(T0, 'no host is ever marked disconnected (no quorum side to judge it)', (s) =>
      hosts(s).every((h) => h.haState === 'connected'),
    ),
    at(by(0, POWER_OFF), 'carrier loss: every vs0 fails over to eth2 at once', (s) =>
      T1.nodes.every((n) => vswitch(s, vs0(n)).activeMember === `node-${n}.eth2`),
    ),
    at(by(0, POWER_OFF), 'quorum and cluster services are back', (s) => {
      const d = derived(s);
      return d.zkQuorum && d.clusterServices === 'up';
    }),
    at(by(KATO, POWER_OFF), 'writes complete again on every VM, on the same hosts', (s) =>
      vms(s).every(
        (v) => v.writePendingS === 0 && v.host !== null && v.id.startsWith(`${v.host}.`),
      ),
    ),
    neverSeen(END, 'ha.vm.restarted'),
    neverSeen(END, 'ha.vm.self-terminated'),
    ...baseInvariants(),
  ],
  narrative:
    'Switch A hangs but keeps carrier, and every host runs its active-backup vs0 on eth0 to Switch A, which is what OVS picks by default. Active-backup only watches carrier, so no bond notices: every CVM is cut off from every other, Zookeeper quorum is lost and writes stop cluster-wide, even though each CVM still has live NVMe paths through Switch B. No side has quorum, so AHV HA restarts nothing. Powering Switch A off turns the hang into carrier loss, every vs0 fails over to Switch B at once, and the cluster recovers.',
  cite: ['ovs-bonding', 'ovs-vswitchd-conf', 'ntnx-ahv-admin-11.2', 'ntnx-ncp-everpure-deploy-7.6'],
  status: 'active',
});
