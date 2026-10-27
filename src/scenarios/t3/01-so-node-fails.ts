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
import { P, REDIRECT_PAUSE } from '../timers';

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
    atCtx(by(REDIRECT_PAUSE), 'those VMs are redirected to another Stargate', (s, ctx) => {
      const affected = vms(snapshotAt(ctx, T0)).filter((v) => v.ownerCvm === cvmId(SO));
      return affected.every((a) => {
        const now = vms(s).find((v) => v.id === a.id);
        return now !== undefined && isRunning(now) && now.ownerCvm !== cvmId(SO);
      });
    }),
    alwaysFrom(T0, 'CO VM IO pause bounded by detection plus redirect stall', (s) =>
      allVms(s, (v) => v.ioPendingS <= REDIRECT_PAUSE + SLACK),
    ),
    atCtx(by(P.hci.rebuildStartDelayS), 'rebuild starts immediately', (_s, ctx) =>
      eventSeen(ctx, 'curator.rebuild.start'),
    ),
    always('no VM is ever placed on a storage-only node', noVmOnStorageOnly),
    neverSeen(END, 'ha.vm.restarted'),
    ...baseInvariants(),
  ],
  narrative:
    'Storage-only node 4 fails. It runs no VMs, so there is nothing for AHV HA to restart, but Curator starts rebuilding its replicas at once. Compute-only VMs whose Stargate was on node 4 have their iSCSI sessions redirected to another storage node after a short pause.',
  cite: ['ntnx-ahv-admin-11.2', 'ntnx-bible-4i', 'ntnx-community-co-nodes'],
  status: 'todo',
});
