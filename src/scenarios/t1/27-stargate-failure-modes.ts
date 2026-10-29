import { defineScenario, type ScenarioDef } from '../define';
import {
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  by,
  eventSeen,
  isRunning,
  neverSeen,
  SLACK,
  T0,
  t1Steady,
  vmsOfNode,
} from '../helpers';
import { cvmId, nodeId, T1 } from '../ids';
import { P, RESET_PAUSE, SILENT_PAUSE, SILENT_PAUSE_MIN } from '../timers';

const CVM = cvmId(1);
const END = T0 + SILENT_PAUSE + 30;

type Mode = 'stop' | 'crash' | 'hang';

/**
 * How one Stargate fails decides the VMs' IO pause (SPEC §6.2 "Autopath on AHV", §14 #12):
 * - `stop` (orderly) and `crash` (the process exits on a live CVM) reset its connections and
 *   release its vDisk leadership at once: the initiators log in elsewhere and IO resumes after the
 *   re-login (`redirectStallS`). A crashed process is restarted by its self-monitor in seconds.
 * - `hang`: the process answers nothing but keeps its connections, so the initiators notice only
 *   by their NOPs; a peer may serve its vDisks only once its ZK session expires, so the first
 *   login parks and IO resumes at the next NOP cycle after the expiry.
 */
function variant(mode: Mode): ScenarioDef {
  const kind =
    mode === 'stop'
      ? 'cvm.stop-stargate'
      : mode === 'crash'
        ? 'cvm.crash-stargate'
        : 'cvm.hang-stargate';
  const silent = mode === 'hang';
  const pause = silent ? SILENT_PAUSE : RESET_PAUSE;
  return defineScenario({
    id: `t1-27-stargate-${mode}`,
    title: `T1: one Stargate ${mode === 'stop' ? 'stops' : mode === 'crash' ? 'crashes' : 'hangs'}`,
    topology: T1.topology,
    durationS: END,
    timeline: [{ at: T0, action: { kind, target: CVM }, note: `Stargate on CVM 1: ${mode}.` }],
    expect: [
      ...t1Steady(),
      alwaysFrom(T0, `node 1 VM IO pause stays within ${pause} s`, (s) =>
        vmsOfNode(s, 1).every((v) => v.ioPendingS <= pause + SLACK),
      ),
      at(by(pause), 'node 1 VMs run on a remote Stargate, still on node 1', (s) =>
        vmsOfNode(s, 1).every((v) => isRunning(v) && v.host === nodeId(1) && v.ownerCvm !== CVM),
      ),
      ...(silent
        ? [
            atCtx(
              by(SILENT_PAUSE),
              'the first login to a peer parks until the ZK expiry',
              (_s, ctx) => eventSeen(ctx, 'redirector.parked', { device: nodeId(1) }),
            ),
            at(T0 + SILENT_PAUSE_MIN - 1, 'IO is still stalled before the ZK expiry', (s) =>
              vmsOfNode(s, 1).every((v) => !isRunning(v)),
            ),
          ]
        : [neverSeen(END, 'redirector.parked')]),
      ...(mode === 'crash'
        ? [
            atCtx(
              by(P.cluster.stargateSelfRestartS),
              'its self-monitor restarts the process within seconds',
              (_s, ctx) => eventSeen(ctx, 'stargate.up', { device: CVM }),
            ),
          ]
        : []),
      neverSeen(END, 'ha.vm.restarted'),
      neverSeen(END, 'vm.crashed'),
      ...baseInvariants(),
    ],
    narrative: silent
      ? "CVM 1's Stargate hangs: it answers neither IO nor NOPs but keeps its connections open, so node 1's VM initiators notice only when their NOPs go unanswered. They log in to a remote Stargate, which may not serve CVM 1's vDisks until CVM 1's Zookeeper session expires, so the first logins park. IO resumes at the initiators' next NOP cycle after the expiry, a much longer pause than a stop or a crash but well inside the initiator session timeout."
      : `CVM 1's Stargate ${mode === 'stop' ? 'is stopped' : 'process crashes on a running CVM'}, which resets its connections and releases its vDisk leadership at once. Node 1's VM initiators log in to a remote Stargate through the host's redirector and IO resumes after about a second${mode === 'crash' ? ', while the self-monitor restarts the process within seconds' : ''}. The sessions fail back only after the local Stargate has been stable for ${P.redirector.failbackStableS} s.`,
    cite: ['ntnx-bible-5b', 'ntnx-blog-cvm-failure', 'ntnx-kb-io-freeze-cvm-down'],
    status: 'active',
  });
}

export default [variant('stop'), variant('crash'), variant('hang')];
