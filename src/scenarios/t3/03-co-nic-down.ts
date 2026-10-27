import { defineScenario, type ScenarioDef } from '../define';
import {
  allRunningAt,
  allVms,
  alwaysFrom,
  at,
  baseInvariants,
  by,
  isRunning,
  neverSeen,
  SLACK,
  T0,
  vmsOfNode,
  vswitch,
} from '../helpers';
import { T3_CO_SO } from '../ids';

type Mode = 'active-backup' | 'balance-slb' | 'balance-tcp';
const CO = 1;
const END = T0 + 60;

const HOW: Record<Mode, string> = {
  'active-backup':
    'With Active-Backup all of its traffic, storage included, moves to the standby uplink.',
  'balance-slb':
    "With MAC pinning the host's interface and VM vNICs that were pinned to eth0 move to eth1.",
  'balance-tcp': 'With LACP the iSCSI sessions hashed to eth0 are rehashed onto eth1.',
};

function variant(mode: Mode): ScenarioDef {
  return defineScenario({
    id: `t3-03-co-nic-down-${mode}`,
    title: `T3 CO+SO: a CO node loses one NIC (${mode})`,
    topology: T3_CO_SO.topology,
    options: { 'vs0-bond-mode': mode, ...(mode === 'balance-tcp' ? { mlag: true } : {}) },
    durationS: END,
    timeline: [
      {
        at: T0,
        action: { kind: 'fail', target: T3_CO_SO.nicA(CO) },
        note: 'CO node 1 eth0 fails.',
      },
    ],
    expect: [
      allRunningAt(T0, 'steady state: all VMs running'),
      at(
        by(0),
        'the bond carries everything on eth1',
        (s) =>
          vswitch(s, T3_CO_SO.vs(CO)).activeMembers === 1 &&
          vmsOfNode(s, CO).every((v) => v.ioUplinks.every((u) => u === T3_CO_SO.nicB(CO))),
      ),
      at(T0, "CO VMs' storage IO crosses the node's uplinks", (s) =>
        vmsOfNode(s, CO).every((v) => v.ioUplinks.length > 0),
      ),
      alwaysFrom(T0, 'CO VM storage IO blips for at most a couple of ticks', (s) =>
        vmsOfNode(s, CO).every((v) => v.ioPendingS <= SLACK),
      ),
      alwaysFrom(by(0), 'all VMs keep running', (s) => allVms(s, isRunning)),
      neverSeen(END, 'redirector.redirect'),
      neverSeen(END, 'ha.host.disconnected'),
      ...baseInvariants(),
    ],
    narrative: `Compute-only node 1 loses one of its two NICs. It has no local CVM, so every storage IO from its VMs crosses this bond to a remote Stargate, and the bond is now in the storage path. ${HOW[mode]} Carrier loss is detected at once in every mode, so VMs see a brief IO blip and no HA event.`,
    cite: ['ntnx-ahv-admin-11.2', 'ntnx-community-co-nodes'],
    status: 'active',
  });
}

export default (['active-backup', 'balance-slb', 'balance-tcp'] as const).map(variant);
