import { defineScenario } from '../define';
import {
  allCvms,
  allPathsLive,
  allRunningAt,
  at,
  atCtx,
  baseInvariants,
  by,
  eventSeen,
  T0,
  vswitch,
} from '../helpers';
import { T1 } from '../ids';
import { P } from '../timers';

const END = T0 + 60;

export default defineScenario({
  id: 't1-17-lacp-no-mlag',
  title: 'T1 misconfiguration: LACP across two switches without MLAG',
  topology: T1.topology,
  options: { 'vlan-placement': 'tagged-both', 'vs1-bond-mode': 'balance-tcp', mlag: false },
  durationS: END,
  timeline: [
    { at: T0, action: { kind: 'fail', target: T1.storageNicA(1) }, note: 'Node 1 eth1 fails.' },
  ],
  expect: [
    atCtx(T0, 'each bond sees two different LACP partners', (_s, ctx) =>
      eventSeen(ctx, 'bond.lacp.partner-mismatch'),
    ),
    at(T0, 'only one member per bond is aggregated', (s) =>
      T1.nodes.every((n) => {
        const vs = vswitch(s, T1.storageVs(n));
        return vs.lacpState === 'partial' && vs.activeMembers === 1;
      }),
    ),
    at(T0, 'storage still works over the single aggregated link', (s) => allCvms(s, allPathsLive)),
    allRunningAt(T0),
    at(
      by(P.bond.lacpFastDetectS),
      'node 1 still has one working member after eth1 fails',
      (s) => vswitch(s, T1.storageVs(1)).activeMembers === 1,
    ),
    allRunningAt(by(P.bond.lacpFastDetectS)),
    ...baseInvariants(),
  ],
  narrative:
    'LACP is enabled on vs1, but the two switches are not an MLAG pair, so each uplink negotiates with a different LACP partner. The bond can aggregate only the members that share a partner, so each node runs on a single uplink and loses the bandwidth and resilience LACP was meant to add. Across two switches, LACP needs MLAG or vPC.',
  cite: ['ntnx-ahv-admin-11.2', 'ntnx-ncp-everpure-deploy-7.6', 'ovs-bonding'],
  status: 'todo',
});
