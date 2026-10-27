import type { ActionRequest } from '../../engine/types';
import { defineScenario, type ScenarioDef } from '../define';
import {
  allRunningAt,
  allVms,
  alwaysFrom,
  at,
  baseInvariants,
  by,
  derived,
  isRunning,
  neverSeen,
  SLACK,
  T0,
  vswitch,
} from '../helpers';
import { SW_A, T2 } from '../ids';

const END = T0 + 60;

function variant(key: 'uplink' | 'tor'): ScenarioDef {
  const action: ActionRequest =
    key === 'uplink' ? { kind: 'fail', target: T2.nicA(1) } : { kind: 'switch.fail', target: SW_A };
  const nodes = key === 'uplink' ? [1] : T2.nodes;
  return defineScenario({
    id: `t2-05-${key}-active-backup`,
    title: `T2: ${key === 'uplink' ? 'one node uplink' : 'ToR switch A'} fails with active-backup bonds`,
    topology: T2.topology,
    options: { 'vs0-bond-mode': 'active-backup' },
    durationS: END,
    timeline: [
      {
        at: T0,
        action,
        note: key === 'uplink' ? 'Node 1 eth0 (Switch A) fails.' : 'Switch A fails.',
      },
    ],
    expect: [
      allRunningAt(T0, 'steady state: all VMs running'),
      at(by(0), 'affected bonds fail over to eth1 on link state', (s) =>
        nodes.every((n) => {
          const vs = vswitch(s, T2.vs(n));
          return vs.activeMembers === 1 && vs.activeMember === T2.nicB(n);
        }),
      ),
      alwaysFrom(T0, 'VMs keep running with at most a brief blip', (s) =>
        allVms(s, (v) => isRunning(v) || v.ioPendingS <= SLACK),
      ),
      alwaysFrom(
        T0,
        'cluster state is untouched',
        (s) =>
          derived(s).zkQuorum && derived(s).resiliency === 'OK' && derived(s).haStatus === 'OK',
      ),
      neverSeen(END, 'redirector.redirect'),
      neverSeen(END, 'ha.host.disconnected'),
      neverSeen(END, 'curator.rebuild.start'),
      ...baseInvariants(),
    ],
    narrative:
      key === 'uplink'
        ? 'Node 1 loses its Switch A uplink. The active-backup bond sees the carrier loss and moves all traffic to eth1 at once, so the cluster never notices: no redirect, no HA event, no rebuild.'
        : 'Switch A fails. Every node bond sees carrier loss and moves to its Switch B uplink at once, and the ISL is no longer needed. The cluster keeps quorum and nothing is redirected, restarted or rebuilt.',
    cite: ['ntnx-ahv-admin-11.2', 'ntnx-bible-5b'],
    status: 'active',
  });
}

export default [variant('uplink'), variant('tor')];
