import { defineScenario } from '../define';
import {
  allRunningAt,
  allVms,
  always,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  by,
  eventSeen,
  isRunning,
  neverSeen,
  noVmOnStorageOnly,
  SLACK,
  snapshotAt,
  T0,
  vms,
} from '../helpers';
import { cvmId, nodeId, T3_CO_SO } from '../ids';
import { NODE_REBUILD_START, P, SILENT_NODE_PAUSE, SILENT_PAUSE, STARGATE_DOWN } from '../timers';

const SO = 4;
const END = by(P.ahvHa.restartByS) + 30;

export default defineScenario({
  id: 't3-01-so-node-fails',
  title: 'T3 CO+SO: a storage-only node fails',
  topology: T3_CO_SO.topology,
  durationS: END,
  timeline: [
    { at: T0, action: { kind: 'power-off', target: nodeId(SO) }, note: 'SO node 4 loses power.' },
  ],
  expect: [
    allRunningAt(T0, 'steady state: all VMs running'),
    at(T0, 'some CO VMs are served by the Stargate on node 4', (s) =>
      vms(s).some((v) => v.ownerCvm === cvmId(SO)),
    ),
    atCtx(by(SILENT_PAUSE), 'those VMs are redirected to another Stargate', (s, ctx) => {
      const affected = vms(snapshotAt(ctx, T0)).filter((v) => v.ownerCvm === cvmId(SO));
      return affected.every((a) => {
        const now = vms(s).find((v) => v.id === a.id);
        return now !== undefined && isRunning(now) && now.ownerCvm !== cvmId(SO);
      });
    }),
    // Writes that need a replica on node 4 stall until its Stargate is declared down (ZK session
    // expiry, `hci.stargateDownDetectS`), which outlasts the redirect.
    alwaysFrom(T0, 'VM IO pause bounded by Stargate-down detection', (s) =>
      allVms(s, (v) => v.ioPendingS <= SILENT_NODE_PAUSE + SLACK),
    ),
    atCtx(by(NODE_REBUILD_START), 'rebuild starts 60 s after node 4 is declared down', (_s, ctx) =>
      eventSeen(ctx, 'curator.rebuild.start'),
    ),
    always('no VM is ever placed on a storage-only node', noVmOnStorageOnly),
    neverSeen(END, 'ha.vm.restarted'),
    ...baseInvariants(),
  ],
  narrative: `Storage-only node 4 fails. It runs no VMs, so there is nothing for AHV HA to restart. Compute-only VMs whose Stargate was on node 4 notice it by their initiators' NOPs and log in to another storage node, which serves them once node 4's Zookeeper session has expired. Writes that need a replica on node 4 stall until the cluster declares its Stargate down (Zookeeper session expiry, ${STARGATE_DOWN} s), and Curator starts rebuilding node 4's replicas ${P.hci.rebuildStartDelayS} s after that.`,
  cite: [
    'ntnx-ahv-admin-11.2',
    'ntnx-bible-4i',
    'ntnx-community-co-nodes',
    'ntnx-kb-io-freeze-cvm-down',
  ],
  status: 'active',
});
