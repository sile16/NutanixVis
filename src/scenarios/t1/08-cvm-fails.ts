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
import { P, REDIRECT_DETECT, REDIRECT_PAUSE } from '../timers';

const CVM = cvmId(1);
const RECOVER_AT = T0 + 90;
/** CVM boot time is not modeled by a profile field; leave ample room for failback. */
const END = RECOVER_AT + P.redirector.failbackStableS + 180;

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
    atCtx(by(REDIRECT_DETECT), 'redirector marks the local Stargate unhealthy', (_s, ctx) =>
      eventSeen(ctx, 'redirector.unhealthy', { device: nodeId(1) }),
    ),
    at(by(REDIRECT_PAUSE), 'node 1 VMs run on a remote Stargate, still on node 1', (s) =>
      vmsOfNode(s, 1).every(
        (v) => isRunning(v) && v.host === nodeId(1) && v.ownerCvm !== null && v.ownerCvm !== CVM,
      ),
    ),
    alwaysFrom(T0, 'node 1 VM IO pause bounded by detection plus redirect stall', (s) =>
      vmsOfNode(s, 1).every((v) => v.ioPendingS <= REDIRECT_PAUSE + SLACK),
    ),
    atCtx(END, 'failback only after the local Stargate is stable for 30 s', (_s, ctx) => {
      const up = firstEventAt(ctx, 'stargate.up', { device: CVM, from: RECOVER_AT });
      const back = firstEventAt(ctx, 'redirector.failback', { device: nodeId(1) });
      return up !== null && back !== null && back - up >= P.redirector.failbackStableS;
    }),
    at(END, 'node 1 VMs are served locally again', (s) =>
      vmsOfNode(s, 1).every((v) => isRunning(v) && v.ownerCvm === CVM),
    ),
    neverSeen(END, 'ha.host.fenced'),
    neverSeen(END, 'ha.vm.restarted'),
    neverSeen(END, 'curator.rebuild.start'),
    ...baseInvariants(),
  ],
  narrative:
    "CVM 1 fails but node 1 keeps running its VMs. The host's iSCSI redirector misses its NOPs, marks the local Stargate unhealthy, and the VMs' IO logs in to a remote Stargate, which takes the vDisk lock and NVMe reservation. There is no HA event and no rebuild, because the array owns the data. When CVM 1 has been stable for 30 s the sessions fail back.",
  cite: ['ntnx-ahv-admin-11.2', 'ntnx-bible-5b', 'ntnx-bible-8c', 'ntnx-blog-cvm-failure'],
  status: 'todo',
});
