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
import {
  NODE_REBUILD_START,
  P,
  REDIRECT_DETECT,
  REDIRECT_PAUSE,
  SILENT_NODE_PAUSE,
  STARGATE_DOWN,
} from '../timers';

const CVM = cvmId(1);
const POWER_ON_AT = T0 + 120;
/**
 * Failback needs the CVM to boot (`cluster.cvmBootS`), then its Stargate to answer NOPs for
 * `failbackStableS`, then the re-login stall (`redirectStallS`) before local IO flows again.
 */
const END = by(
  P.cluster.cvmBootS + P.redirector.failbackStableS + P.redirector.redirectStallS,
  POWER_ON_AT,
);

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
    // After the redirect, the remote Stargate's writes still need CVM 1's replica until CVM 1 is
    // declared down (a hard power-off: ZK session expiry, `hci.stargateDownDetectS`).
    alwaysFrom(T0, 'node 1 VM IO pause bounded by Stargate-down detection', (s) =>
      vmsOfNode(s, 1).every((v) => v.ioPendingS <= SILENT_NODE_PAUSE + SLACK),
    ),
    atCtx(by(NODE_REBUILD_START), 'rebuild starts 60 s after CVM 1 is declared down', (_s, ctx) =>
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
  narrative: `CVM 1 is powered off while node 1 keeps running its VMs. The host's iSCSI redirector misses two NOPs, marks the local Stargate unhealthy, and QEMU's iSCSI login is redirected to a healthy remote Stargate after a short pause. Writes that need a replica on CVM 1 stall until the cluster declares its Stargate down (Zookeeper session expiry, ${STARGATE_DOWN} s), and Curator starts rebuilding the lost replicas ${P.hci.rebuildStartDelayS} s after that. When CVM 1 is back and its Stargate has been stable for ${P.redirector.failbackStableS} s, the VMs fail back to local IO.`,
  cite: [
    'ntnx-ahv-admin-11.2',
    'ntnx-bible-5b',
    'ntnx-bible-4i',
    'ntnx-blog-cvm-failure',
    'ntnx-kb-io-freeze-cvm-down',
  ],
  status: 'active',
});
