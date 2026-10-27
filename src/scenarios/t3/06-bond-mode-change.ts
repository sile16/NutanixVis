import type { Snapshot } from '../../engine/types';
import { defineScenario } from '../define';
import {
  allRunningAt,
  allVms,
  alwaysFrom,
  at,
  atCtx,
  type BondMode,
  baseInvariants,
  eventSeen,
  hosts,
  neverSeen,
  SLACK,
  T0,
  vswitch,
} from '../helpers';
import { T3_CO_SO } from '../ids';

const TO_SLB = T0;
const TO_TCP = T0 + 30;
const END = TO_TCP + 30;

const allHostsRun = (mode: BondMode, members: number) => (s: Snapshot) =>
  hosts(s).every((h) => {
    const vs = vswitch(s, `${h.id}.vs0`);
    return vs.bondMode === mode && vs.activeMembers === members;
  });

export default defineScenario({
  id: 't3-06-bond-mode-change-under-load',
  title: 'T3 CO+SO: change the bond mode mid-scenario under load',
  topology: T3_CO_SO.topology,
  options: { 'vs0-bond-mode': 'active-backup', mlag: true },
  durationS: END,
  timeline: [
    {
      at: TO_SLB,
      action: {
        kind: 'vswitch.set-bond-mode',
        target: T3_CO_SO.vs(1),
        params: { mode: 'balance-slb' },
      },
      note: 'Switch vs0 to Active-Active with MAC pinning (applies to every host).',
    },
    {
      at: TO_TCP,
      action: {
        kind: 'vswitch.set-bond-mode',
        target: T3_CO_SO.vs(1),
        params: { mode: 'balance-tcp' },
      },
      note: 'Switch vs0 to Active-Active (LACP) across the MLAG pair.',
    },
  ],
  expect: [
    allRunningAt(T0, 'steady state: all VMs running'),
    at(T0, 'every host starts in Active-Backup on one uplink', allHostsRun('active-backup', 1)),
    atCtx(
      TO_SLB + 5,
      'every host now runs MAC pinning on both uplinks',
      (s, ctx) => allHostsRun('balance-slb', 2)(s) && eventSeen(ctx, 'net.bond.mode-changed'),
    ),
    at(
      TO_TCP + 5,
      'every host now runs LACP on both uplinks',
      (s) =>
        allHostsRun('balance-tcp', 2)(s) &&
        hosts(s).every((h) => vswitch(s, `${h.id}.vs0`).lacpState === 'negotiated'),
    ),
    alwaysFrom(T0, 'VM IO keeps flowing through the changes', (s) =>
      allVms(s, (v) => v.ioPendingS <= SLACK),
    ),
    neverSeen(END, 'ha.host.disconnected'),
    ...baseInvariants(),
  ],
  narrative:
    'The vs0 bond mode is changed while compute-only VMs are running, and the change applies to every host because Nutanix does not support mixed bond modes. Watch storage traffic spread from one uplink to both under MAC pinning, then rehash per TCP session under LACP. In a real cluster, enabling LACP from Prism does a rolling host reboot, and an uplink update that takes over 30 s triggers HA.',
  cite: ['ntnx-ahv-admin-11.2', 'ovs-bonding'],
  status: 'todo',
});
