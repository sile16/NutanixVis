import { defineScenario } from '../define';
import {
  allRunningAt,
  at,
  atCtx,
  baseInvariants,
  before,
  by,
  cvm,
  eventsMatching,
  firstEventAt,
  host,
  isRunning,
  T0,
  vmsOfNode,
} from '../helpers';
import { nodeId, T2 } from '../ids';
import { P } from '../timers';

const HA = P.ahvHa;
const ISO = nodeId(2);
const END = by(HA.restartByS) + 30;

export default defineScenario({
  id: 't2-03-host-isolation',
  title: 'T2: host network isolation; isolated VMs self-terminate at 45 s',
  topology: T2.topology,
  durationS: END,
  timeline: [
    { at: T0, action: { kind: 'host.isolate', target: ISO }, note: 'Node 2 is isolated.' },
  ],
  expect: [
    allRunningAt(T0, 'steady state: all VMs running'),
    at(by(0), 'node 2 is in the ZK minority', (s) => !cvm(s, 2).zkQuorum),
    at(by(0), 'node 2 VMs cannot complete writes', (s) =>
      vmsOfNode(s, 2).every((v) => v.writePendingS > 0),
    ),
    atCtx(
      before(HA.isolatedVmSelfTerminateS),
      'no self-termination before 45 s',
      (_s, ctx) => eventsMatching(ctx, 'ha.vm.self-terminated').length === 0,
    ),
    atCtx(
      by(HA.isolatedVmSelfTerminateS),
      'isolated VMs self-terminate 45 s after the first failed IO',
      (s, ctx) =>
        vmsOfNode(s, 2).every(
          (v) => firstEventAt(ctx, 'ha.vm.self-terminated', { device: v.id }) !== null,
        ),
    ),
    at(
      by(HA.fenceAtS),
      'the majority side fences node 2',
      (s) => host(s, ISO).haState === 'fenced',
    ),
    at(by(HA.restartByS), 'node 2 VMs run on the majority side by T+120', (s) =>
      vmsOfNode(s, 2).every((v) => isRunning(v) && v.host !== ISO),
    ),
    atCtx(by(HA.restartByS), 'every restart comes after that VM self-terminated', (s, ctx) =>
      vmsOfNode(s, 2).every((v) => {
        const died = firstEventAt(ctx, 'ha.vm.self-terminated', { device: v.id });
        const back = firstEventAt(ctx, 'ha.vm.restarted', { device: v.id });
        return died !== null && back !== null && back > died;
      }),
    ),
    ...baseInvariants(),
  ],
  narrative:
    'Node 2 loses its network but keeps running. Its Stargate cannot complete replicated writes and its CVM is in the Zookeeper minority, so VM writes fail. Each isolated VM terminates itself 45 s after its first failed IO, before the majority side fences the host at T+60 and restarts the VMs by T+120, so no VM ever runs twice.',
  cite: ['ntnx-bible-5b', 'ntnx-bible-4i', 'ntnx-ahv-admin-11.2'],
  status: 'active',
});
