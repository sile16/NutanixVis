import { defineScenario } from '../define';
import {
  allRunningAt,
  allVms,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  by,
  derived,
  eventSeen,
  firstEventAt,
  isRunning,
  neverSeen,
  SLACK,
  T0,
  vmsOfNode,
  wasEver,
} from '../helpers';
import { cvmId, nodeId, T2 } from '../ids';
import { P, REDIRECT_DETECT, REDIRECT_PAUSE } from '../timers';

const CVM = cvmId(1);
const POWER_ON_AT = T0 + 120;
/** CVM boot time is not a profile field; leave ample room for failback. */
const END = POWER_ON_AT + P.redirector.failbackStableS + 180;

export default defineScenario({
  id: 't2-01-cvm-power-off-autopath',
  title: 'T2: CVM power-off triggers Autopath, then failback after 30 s stable',
  topology: T2.topology,
  durationS: END,
  timeline: [
    { at: T0, action: { kind: 'power-off', target: CVM }, note: 'Power off CVM 1.' },
    { at: POWER_ON_AT, action: { kind: 'recover', target: CVM }, note: 'Power CVM 1 back on.' },
  ],
  expect: [
    allRunningAt(T0, 'steady state: all VMs running'),
    atCtx(by(REDIRECT_DETECT), 'redirector marks the local Stargate unhealthy', (_s, ctx) =>
      eventSeen(ctx, 'redirector.unhealthy', { device: nodeId(1) }),
    ),
    at(by(REDIRECT_PAUSE), 'node 1 VMs keep running, served by a remote Stargate', (s) =>
      vmsOfNode(s, 1).every(
        (v) => isRunning(v) && v.host === nodeId(1) && v.ownerCvm !== null && v.ownerCvm !== CVM,
      ),
    ),
    alwaysFrom(T0, 'node 1 VM IO pause bounded by detection plus redirect stall', (s) =>
      vmsOfNode(s, 1).every((v) => v.ioPendingS <= REDIRECT_PAUSE + SLACK),
    ),
    atCtx(by(P.hci.rebuildStartDelayS + REDIRECT_DETECT), 'rebuild starts immediately', (_s, ctx) =>
      eventSeen(ctx, 'curator.rebuild.start'),
    ),
    atCtx(POWER_ON_AT, 'resiliency shows Rebuilding', (_s, ctx) =>
      wasEver(ctx, (s) => derived(s).resiliency === 'Rebuilding', T0),
    ),
    alwaysFrom(
      T0,
      'ZK keeps quorum and storage stays available',
      (s) => derived(s).zkQuorum && derived(s).dataAvailable,
    ),
    atCtx(END, 'failback only after the local Stargate is stable for 30 s', (_s, ctx) => {
      const up = firstEventAt(ctx, 'stargate.up', { device: CVM, from: POWER_ON_AT });
      const back = firstEventAt(ctx, 'redirector.failback', { device: nodeId(1) });
      return up !== null && back !== null && back - up >= P.redirector.failbackStableS;
    }),
    at(END, 'node 1 VMs are served locally again', (s) =>
      vmsOfNode(s, 1).every((v) => isRunning(v) && v.ownerCvm === CVM),
    ),
    alwaysFrom(T0, 'VMs on other nodes keep running', (s) =>
      allVms(s, (v) => v.id.startsWith(`${nodeId(1)}.`) || isRunning(v)),
    ),
    neverSeen(END, 'ha.vm.restarted'),
    ...baseInvariants(),
  ],
  narrative:
    "CVM 1 is powered off while node 1 keeps running its VMs. The host's iSCSI redirector misses two NOPs, marks the local Stargate unhealthy, and QEMU's iSCSI login is redirected to a healthy remote Stargate after a short pause. Curator starts rebuilding the lost replicas right away. When CVM 1 is back and its Stargate has been stable for 30 s, the VMs fail back to local IO.",
  cite: ['ntnx-ahv-admin-11.2', 'ntnx-bible-5b', 'ntnx-bible-4i', 'ntnx-blog-cvm-failure'],
  status: 'todo',
});
