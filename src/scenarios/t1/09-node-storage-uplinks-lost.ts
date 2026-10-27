import { defineScenario } from '../define';
import {
  allPathsLive,
  allRunningAt,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  by,
  cvm,
  cvmPathsUp,
  eventSeen,
  host,
  isRunning,
  isStalled,
  neverSeen,
  T0,
  t1Steady,
  vms,
  vmsOfNode,
} from '../helpers';
import { cvmId, nodeId, T1 } from '../ids';
import { KATO, P } from '../timers';

const RESTORE_AT = T0 + 180;
const END = by(P.externalStorage.reconnectDelayS + KATO, RESTORE_AT) + 10;

export default defineScenario({
  id: 't1-09-node-storage-uplinks-lost',
  title: 'T1: a node loses both storage uplinks but keeps vs0',
  topology: T1.topology,
  durationS: END,
  timeline: [
    { at: T0, action: { kind: 'fail', target: T1.storageNicA(1) }, note: 'Node 1 eth1 fails.' },
    { at: T0, action: { kind: 'fail', target: T1.storageNicB(1) }, note: 'Node 1 eth3 fails.' },
    { at: RESTORE_AT, action: { kind: 'recover', target: T1.storageNicA(1) } },
    { at: RESTORE_AT, action: { kind: 'recover', target: T1.storageNicB(1) } },
  ],
  expect: [
    ...t1Steady(),
    atCtx(
      by(KATO),
      'CVM 1 loses every NVMe path',
      (s, ctx) =>
        cvmPathsUp(s, 1) === 0 && eventSeen(ctx, 'nvme.all-paths.lost', { device: cvmId(1) }),
    ),
    // [OPEN-6] assumption: Stargate still answers NOPs, so the redirector does not move.
    at(RESTORE_AT, 'node 1 VMs stall in place, still owned by CVM 1', (s) =>
      vmsOfNode(s, 1).every((v) => isStalled(v) && v.host === nodeId(1) && v.ownerCvm === cvmId(1)),
    ),
    alwaysFrom(T0, 'Stargate on CVM 1 stays up', (s) => cvm(s, 1).stargate === 'up'),
    alwaysFrom(
      T0,
      'node 1 stays connected to the cluster via vs0',
      (s) => host(s, 1).haState === 'connected',
    ),
    alwaysFrom(T0, 'VMs on other nodes keep running', (s) =>
      vms(s)
        .filter((v) => !v.id.startsWith(`${nodeId(1)}.`))
        .every(isRunning),
    ),
    neverSeen(END, 'ha.vm.restarted'),
    neverSeen(END, 'vm.force-shutdown'),
    at(END, 'paths come back once the uplinks return', (s) => allPathsLive(cvm(s, 1))),
    allRunningAt(END, 'node 1 VMs resume when the array answers again'),
    ...baseInvariants(),
  ],
  narrative:
    "Node 1 loses both vs1 uplinks but keeps management on vs0, so the cluster still sees the host as healthy. Its CVM loses every NVMe path while Stargate keeps answering the redirector, so the VMs' IO stays with the local CVM and retries until the array responds. Without a per-VM force-shutdown timeout the VMs stall in place, then resume as soon as the uplinks return.",
  cite: ['ntnx-ncp-everpure-deploy-7.6', 'ntnx-bible-5b', 'ntnx-bible-8c'],
  status: 'todo',
});
