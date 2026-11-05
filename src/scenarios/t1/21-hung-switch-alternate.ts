import { defineScenario } from '../define';
import {
  alwaysFrom,
  at,
  baseInvariants,
  by,
  derived,
  hosts,
  isRunning,
  neverSeen,
  T0,
  t1Steady,
  vms,
  vswitch,
} from '../helpers';
import { SW_A, T1 } from '../ids';
import { P } from '../timers';

const HA = P.ahvHa;
/**
 * The horizon an isolated host would need to be fenced and its VMs restarted: ZK seats move after
 * `serviceVolumeMigrationDelayS`, the new leader's disconnect timeout runs, then the restart.
 */
const RESTART =
  P.cluster.serviceVolumeMigrationDelayS + HA.disconnectTimeoutS + HA.restartByS - HA.fenceAtS;
const END = by(RESTART) + 20;

export default defineScenario({
  id: 't1-21-hung-switch-alternate',
  title: 'T1: Switch A hangs; with vs0 LACP no host is isolated or fenced',
  topology: T1.topology,
  // Pinning the active-backup member per host has no effect on an LACP bond: both members carry.
  options: { 'vs0-active-member': 'alternate' },
  durationS: END,
  timeline: [
    {
      at: T0,
      action: { kind: 'switch.hang', target: SW_A },
      note: 'Switch A stops forwarding but keeps carrier on every port.',
    },
  ],
  expect: [
    ...t1Steady(),
    at(T0, 'vs0-active-member does not apply: every vs0 is LACP with both members carrying', (s) =>
      T1.nodes.every((n) => {
        const v = vswitch(s, `node-${n}.vs0`);
        return v.bondMode === 'balance-tcp' && v.activeMember === null && v.activeMembers === 2;
      }),
    ),
    at(by(P.bond.lacpFastDetectS), 'every vs0 has dropped its Switch A member', (s) =>
      T1.nodes.every((n) => vswitch(s, `node-${n}.vs0`).activeMembers === 1),
    ),
    alwaysFrom(
      T0,
      'Zookeeper quorum holds throughout: no seat moves',
      (s) => derived(s).zkQuorum === true,
    ),
    alwaysFrom(T0, 'no host is disconnected or fenced', (s) =>
      hosts(s).every((h) => h.haState === 'connected'),
    ),
    alwaysFrom(T0, 'every VM keeps running on its own host', (s) =>
      vms(s).every((v) => isRunning(v) && v.host !== null && v.id.startsWith(`${v.host}.`)),
    ),
    neverSeen(END, 'ha.host.disconnected'),
    neverSeen(END, 'ha.vm.self-terminated'),
    neverSeen(END, 'ha.vm.restarted'),
    ...baseInvariants(),
  ],
  narrative:
    'The same hung Switch A, watched over the whole AHV HA horizon. With Active-Backup on vs0, the hosts active on Switch A would be cut off, the Zookeeper seats would move after five minutes, and AHV HA would fence those hosts and restart their VMs elsewhere; pinning half the hosts to each switch (vs0-active-member alternate) only limited that to two hosts. With vs0 as Active-Active LACP the option has nothing to pin: both members carry traffic, each vs0 detaches its Switch A member within about 3 s, and no host is isolated, no seat moves, nothing is fenced and every VM stays where it is.',
  cite: ['ovs-lacp-source', 'ntnx-bible-5b', 'ntnx-ahv-admin-11.2'],
  status: 'active',
});
