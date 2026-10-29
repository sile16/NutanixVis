import { defineScenario } from '../define';
import {
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  by,
  eventSeen,
  firstEventAt,
  isRunning,
  neverSeen,
  SLACK,
  T0,
  t1Steady,
  vmsOfNode,
} from '../helpers';
import { cvmId, nodeId, T1 } from '../ids';
import { failbackDoneS, P, REDIRECT_DETECT, SILENT_PAUSE, SILENT_PAUSE_MIN } from '../timers';

const CVM = cvmId(1);
const RECOVER_AT = T0 + 90;
/**
 * Failback needs the CVM to boot (`cluster.cvmBootS`), then its Stargate to answer for
 * `failbackStableS`, then one vDisk per `failbackStepS` with a re-login pause each.
 */
const END = by(P.cluster.cvmBootS + failbackDoneS(4), RECOVER_AT);

export default defineScenario({
  id: 't1-08-cvm-fails',
  title: 'T1: a CVM fails while its host stays up',
  topology: T1.topology,
  durationS: END,
  timeline: [
    { at: T0, action: { kind: 'fail', target: CVM }, note: 'CVM 1 fails; node 1 stays up.' },
    { at: RECOVER_AT, action: { kind: 'recover', target: CVM }, note: 'CVM 1 comes back.' },
  ],
  expect: [
    ...t1Steady(),
    atCtx(
      by(REDIRECT_DETECT),
      "the initiators' NOPs to the silent local Stargate go unanswered",
      (_s, ctx) => eventSeen(ctx, 'redirector.unhealthy', { device: nodeId(1) }),
    ),
    atCtx(
      by(REDIRECT_DETECT),
      'the first login to a peer parks: CVM 1 still holds its vDisks until its ZK session expires',
      (_s, ctx) => eventSeen(ctx, 'redirector.parked', { device: nodeId(1) }),
    ),
    at(T0 + SILENT_PAUSE_MIN - 1, 'node 1 VM IO is still stalled before the ZK expiry', (s) =>
      vmsOfNode(s, 1).every((v) => !isRunning(v)),
    ),
    at(by(SILENT_PAUSE), 'node 1 VMs run on a remote Stargate, still on node 1', (s) =>
      vmsOfNode(s, 1).every(
        (v) => isRunning(v) && v.host === nodeId(1) && v.ownerCvm !== null && v.ownerCvm !== CVM,
      ),
    ),
    alwaysFrom(T0, 'node 1 VM IO pause bounded by ZK expiry plus one NOP cycle', (s) =>
      vmsOfNode(s, 1).every((v) => v.ioPendingS <= SILENT_PAUSE + SLACK),
    ),
    atCtx(
      END,
      `failback only after the local Stargate is stable for ${P.redirector.failbackStableS} s`,
      (_s, ctx) => {
        const up = firstEventAt(ctx, 'stargate.up', { device: CVM, from: RECOVER_AT });
        const back = firstEventAt(ctx, 'redirector.failback', { device: nodeId(1) });
        return up !== null && back !== null && back - up >= P.redirector.failbackStableS;
      },
    ),
    at(END, 'node 1 VMs are served locally again', (s) =>
      vmsOfNode(s, 1).every((v) => isRunning(v) && v.ownerCvm === CVM),
    ),
    neverSeen(END, 'ha.host.fenced'),
    neverSeen(END, 'ha.vm.restarted'),
    neverSeen(END, 'curator.rebuild.start'),
    ...baseInvariants(),
  ],
  narrative:
    "CVM 1 fails but node 1 keeps running its VMs; their iSCSI initiators notice the silent Stargate only when their NOPs go unanswered, and log in to a remote Stargate through the host's redirector. That Stargate may not serve CVM 1's vDisks until CVM 1's Zookeeper session expires, so the first logins park and IO resumes at the next NOP cycle after it, with no HA event and no rebuild because the array owns the data. Failback is much slower than the failover: once CVM 1 has been stable for 300 s, the sessions return one vDisk at a time.",
  cite: ['ntnx-ahv-admin-11.2', 'ntnx-bible-5b', 'ntnx-bible-8c', 'ntnx-blog-cvm-failure'],
  status: 'active',
});
