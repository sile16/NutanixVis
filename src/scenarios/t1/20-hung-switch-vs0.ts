import { defineScenario } from '../define';
import {
  allCvms,
  allVms,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  before,
  by,
  derived,
  eventSeen,
  faInterfacesBehind,
  hosts,
  isRunning,
  neverSeen,
  onlyPathsLostTo,
  SLACK,
  T0,
  t1Steady,
  vms,
  vswitch,
} from '../helpers';
import { SW_A, T1 } from '../ids';
import { KATO, P, PATH_LOSS_RULE, PATH_LOSS_WORST } from '../timers';

const DETECT = P.bond.lacpFastDetectS;
const END = by(PATH_LOSS_WORST) + 30;
const vs0 = (n: number): string => `node-${n}.vs0`;

export default defineScenario({
  id: 't1-20-hung-switch-vs0',
  title: 'T1: Switch A hangs with carrier up; vs0 LACP detects it',
  topology: T1.topology,
  durationS: END,
  timeline: [
    {
      at: T0,
      action: { kind: 'switch.hang', target: SW_A },
      note: 'Switch A stops forwarding (and sending LACPDUs) but keeps carrier on every port.',
    },
  ],
  expect: [
    ...t1Steady(),
    at(T0, 'every vs0 is an LACP bond over both switches (MLAG), both members negotiated', (s) =>
      T1.nodes.every((n) => {
        const v = vswitch(s, vs0(n));
        return (
          v.bondMode === 'balance-tcp' && v.lacpState === 'negotiated' && v.activeMembers === 2
        );
      }),
    ),
    at(before(DETECT), 'until the LACP timeout the Switch A member still counts as up', (s) =>
      T1.nodes.every((n) => vswitch(s, vs0(n)).activeMembers === 2),
    ),
    atCtx(by(DETECT), 'every vs0 detaches its Switch A member at the fast LACP timeout', (s, ctx) =>
      T1.nodes.every(
        (n) =>
          vswitch(s, vs0(n)).activeMembers === 1 &&
          eventSeen(ctx, 'net.bond.lacp-timeout', { device: vs0(n) }),
      ),
    ),
    alwaysFrom(
      T0,
      'Zookeeper quorum and cluster services stay up (the blip is shorter than a ZK session)',
      (s) => {
        const d = derived(s);
        return d.zkQuorum === true && d.clusterServices === 'up';
      },
    ),
    at(
      by(KATO),
      'storage loses only the paths behind Switch A (MAC pinning on vs1 cannot see a hang)',
      (s) => allCvms(s, (c) => onlyPathsLostTo(c, faInterfacesBehind(s, SW_A))),
    ),
    alwaysFrom(T0, 'VMs keep running', (s) => allVms(s, isRunning)),
    alwaysFrom(T0, `no command waits longer than ${PATH_LOSS_RULE}`, (s) =>
      vms(s).every((v) => v.ioPendingS <= PATH_LOSS_WORST + SLACK),
    ),
    alwaysFrom(T0, 'no host is ever marked disconnected', (s) =>
      hosts(s).every((h) => h.haState === 'connected'),
    ),
    neverSeen(END, 'ha.vm.restarted'),
    neverSeen(END, 'ha.vm.self-terminated'),
    ...baseInvariants(),
  ],
  narrative:
    'Switch A hangs but keeps carrier. Every host runs vs0 as Active-Active LACP over the MLAG pair, and OVS judges LACP liveness by LACPDU receipt: the hung switch stops sending them, so at the fast rate each vs0 detaches its Switch A member within about 3 s and carries management, CVM-to-CVM and redirect traffic on Switch B. That is shorter than a Zookeeper session, so quorum and cluster services never drop and AHV HA does nothing; storage is different: vs1 uses MAC pinning, which only watches carrier, so the VLAN-A interfaces stay pinned to Switch A, their paths are lost after the keep-alive timeout, and IO continues on VLAN B. With Active-Backup on vs0 (the deployment guide default) no bond would notice the hang, and every CVM would be cut off from every other.',
  cite: ['ovs-lacp-source', 'ovs-bonding', 'ntnx-ahv-admin-11.2', 'ntnx-ncp-everpure-deploy-7.6'],
  status: 'active',
});
