import { defineScenario } from '../define';
import {
  allRunningAt,
  allVms,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  before,
  by,
  derived,
  eventsMatching,
  firstEventAt,
  hosts,
  neverSeen,
  T0,
  vms,
} from '../helpers';
import { SW_A, SW_B, T2 } from '../ids';
import { P } from '../timers';

const HA = P.ahvHa;
const RECOVER_AT = T0 + 120;
/**
 * No timing is published for the restart after a total partition. In the model quorum re-forms
 * on the first tick the network is back, the next Acropolis leader is elected at once (its
 * re-election delay has long passed) and restarts the VMs at its first HA cycle.
 */
const RESTART_WITHIN = 10;
const END = by(RESTART_WITHIN + 20, RECOVER_AT);

export default defineScenario({
  id: 't2-12-total-partition',
  title: 'T2: both ToR switches fail, so no partition has quorum (VMs self-terminate)',
  topology: T2.topology,
  durationS: END,
  timeline: [
    { at: T0, action: { kind: 'fail', target: SW_A }, note: 'Switch A fails.' },
    { at: T0, action: { kind: 'fail', target: SW_B }, note: 'Switch B fails.' },
    { at: RECOVER_AT, action: { kind: 'recover', target: SW_A } },
    { at: RECOVER_AT, action: { kind: 'recover', target: SW_B } },
  ],
  expect: [
    allRunningAt(T0, 'steady state: all VMs running'),
    at(by(0), 'every CVM is alone: no Zookeeper quorum anywhere', (s) => !derived(s).zkQuorum),
    at(by(0), 'every VM has IO it cannot complete (reads and writes)', (s) =>
      allVms(s, (v) => v.readPendingS > 0 && v.writePendingS > 0),
    ),
    atCtx(
      before(HA.isolatedVmSelfTerminateS),
      'no self-termination before 45 s',
      (_s, ctx) => eventsMatching(ctx, 'ha.vm.self-terminated').length === 0,
    ),
    // `inferred` (Bible 5b ties self-termination to IO failure; field report: VMs "fence").
    atCtx(
      by(HA.isolatedVmSelfTerminateS),
      'every VM self-terminates 45 s after its first failed IO',
      (s, ctx) =>
        vms(s).every((v) => firstEventAt(ctx, 'ha.vm.self-terminated', { device: v.id }) !== null),
    ),
    at(
      by(P.cluster.zkSessionTimeoutS),
      'cluster services and Prism Element are down',
      (s) => derived(s).clusterServices === 'down' && s.derived.prismElement === 'unreachable',
    ),
    alwaysFrom(T0, 'no host is fenced (no Acropolis leader acts)', (s) =>
      hosts(s).every((h) => h.haState !== 'fenced'),
    ),
    atCtx(RECOVER_AT, 'no VM is restarted while no quorum exists', (_s, ctx) =>
      eventsMatching(ctx, 'ha.vm.restarted').every((e) => e.t > RECOVER_AT),
    ),
    // Anecdotal (public field report): "The system will return to its previous state."
    atCtx(
      by(RESTART_WITHIN, RECOVER_AT),
      'once quorum re-forms the new leader restarts every VM',
      (s, ctx) =>
        allVms(s, (v) => v.state === 'running') &&
        vms(s).every(
          (v) => firstEventAt(ctx, 'ha.vm.restarted', { device: v.id, from: RECOVER_AT }) !== null,
        ),
    ),
    at(END, 'cluster services are back', (s) => derived(s).clusterServices === 'up'),
    neverSeen(END, 'ha.host.fenced'),
    ...baseInvariants(),
  ],
  narrative:
    'Both top-of-rack switches fail, so every CVM is cut off from every other one and no partition holds a Zookeeper majority. The local Stargates can no longer resolve metadata or replicate writes, so every VM has failing IO and terminates itself 45 s after its first failed IO. When the switches return, quorum re-forms, the new Acropolis leader restarts the VMs that were running, and the cluster returns to its previous state.',
  cite: ['ntnx-bible-5b', 'ntnx-bible-4i', 'reddit-nutanix-all-nodes-network-loss'],
  status: 'active',
});
