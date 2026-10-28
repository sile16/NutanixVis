import { defineScenario, type ScenarioDef } from '../define';
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
  firstEventAt,
  host,
  isRunning,
  isStalled,
  neverSeen,
  SLACK,
  T0,
  t1Steady,
  vms,
  vmsOfNode,
} from '../helpers';
import { cvmId, nodeId, T1 } from '../ids';
import { HADES_DETECT, HADES_RECOVER, KATO, P, REDIRECT_PAUSE } from '../timers';

const CVM = cvmId(1);
const RESTORE_AT = T0 + 180;

const otherVmsRun = alwaysFrom(T0, 'VMs on other nodes keep running', (s) =>
  vms(s)
    .filter((v) => !v.id.startsWith(`${nodeId(1)}.`))
    .every(isRunning),
);
const hostConnected = alwaysFrom(
  T0,
  'node 1 stays connected to the cluster via vs0',
  (s) => host(s, 1).haState === 'connected',
);
const pathsLost = atCtx(
  by(KATO),
  'CVM 1 loses every NVMe path',
  (s, ctx) => cvmPathsUp(s, 1) === 0 && eventSeen(ctx, 'nvme.all-paths.lost', { device: CVM }),
);

/**
 * Default (`hades-maintenance-on-storage-error: on`, `inferred`). CVM 1's service volumes are
 * on the array too, so Hades puts node 1 in maintenance mode HADES_DETECT after the loss; its
 * Stargate stops and the redirector moves the VMs' IO to a CVM that still reaches the array
 * (REDIRECT_PAUSE). Recovery waits for the next periodic re-map after the uplinks return, then
 * the services restart (HADES_RECOVER from maintenance), then the sessions fail back after
 * `failbackStableS` plus the re-login stall.
 */
function hades(): ScenarioDef {
  const END =
    by(
      HADES_DETECT +
        HADES_RECOVER +
        P.redirector.failbackStableS +
        P.redirector.redirectStallS +
        P.redirector.nopIntervalS,
    ) + 5;
  return defineScenario({
    id: 't1-09-node-storage-uplinks-lost',
    title: 'T1: a node loses both storage uplinks but keeps vs0 (Hades maintenance mode)',
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
      pathsLost,
      atCtx(by(HADES_DETECT), 'Hades puts node 1 in maintenance mode', (_s, ctx) =>
        eventSeen(ctx, 'hades.maintenance.enter', { device: CVM }),
      ),
      at(by(HADES_DETECT + REDIRECT_PAUSE), 'node 1 VMs run on a remote Stargate', (s) =>
        vmsOfNode(s, 1).every(
          (v) => isRunning(v) && v.host === nodeId(1) && v.ownerCvm !== null && v.ownerCvm !== CVM,
        ),
      ),
      alwaysFrom(T0, 'node 1 VM IO pause bounded by Hades detection plus the redirect', (s) =>
        vmsOfNode(s, 1).every((v) => v.ioPendingS <= HADES_DETECT + REDIRECT_PAUSE + SLACK),
      ),
      hostConnected,
      otherVmsRun,
      atCtx(
        END,
        'services restart only at the periodic re-map after the uplinks return',
        (_s, ctx) => {
          const entered = firstEventAt(ctx, 'hades.maintenance.enter', { device: CVM });
          const remapped = firstEventAt(ctx, 'hades.volumes.remapped', { device: CVM });
          const up = firstEventAt(ctx, 'stargate.up', { device: CVM, from: RESTORE_AT });
          return (
            entered !== null &&
            remapped === entered + P.hades.mapNvmfVolumesIntervalS &&
            up === remapped + P.cluster.cvmBootS
          );
        },
      ),
      at(
        END,
        'paths are back and node 1 VMs are served locally again',
        (s) =>
          allPathsLive(cvm(s, 1)) &&
          vmsOfNode(s, 1).every((v) => isRunning(v) && v.ownerCvm === CVM),
      ),
      neverSeen(END, 'ha.vm.restarted'),
      neverSeen(END, 'vm.force-shutdown'),
      ...baseInvariants(),
    ],
    narrative:
      "Node 1 loses both vs1 uplinks but keeps management on vs0, so the cluster still sees the host as healthy. Its CVM loses every NVMe path, including the ones to its own Zookeeper and Cassandra service volumes, so after a few seconds Hades puts the node in maintenance mode and its Stargate stops. The redirector then moves the VMs' IO to a CVM that still reaches the array, with no HA event. After the uplinks return, the next periodic re-map brings the services back and the sessions fail back.",
    cite: ['ntnx-cmdref-aos-7.6', 'ntnx-bible-8c', 'ntnx-bible-5b', 'everpure-nutanix-nci-cfg'],
    status: 'active',
  });
}

/** Lab comparison (`hades-maintenance-on-storage-error: off`): DEPLOY-GUIDE retry in place. */
function retryInPlace(): ScenarioDef {
  const END = by(P.externalStorage.reconnectDelayS + KATO, RESTORE_AT) + 10;
  return defineScenario({
    id: 't1-09-node-storage-uplinks-lost-hades-off',
    title: 'T1: a node loses both storage uplinks but keeps vs0 (Hades maintenance off)',
    topology: T1.topology,
    options: { 'hades-maintenance-on-storage-error': 'off' },
    durationS: END,
    timeline: [
      { at: T0, action: { kind: 'fail', target: T1.storageNicA(1) }, note: 'Node 1 eth1 fails.' },
      { at: T0, action: { kind: 'fail', target: T1.storageNicB(1) }, note: 'Node 1 eth3 fails.' },
      { at: RESTORE_AT, action: { kind: 'recover', target: T1.storageNicA(1) } },
      { at: RESTORE_AT, action: { kind: 'recover', target: T1.storageNicB(1) } },
    ],
    expect: [
      ...t1Steady(),
      pathsLost,
      // Stargate still answers NOPs, so the redirector does not move.
      at(RESTORE_AT, 'node 1 VMs stall in place, still owned by CVM 1', (s) =>
        vmsOfNode(s, 1).every((v) => isStalled(v) && v.host === nodeId(1) && v.ownerCvm === CVM),
      ),
      alwaysFrom(T0, 'Stargate on CVM 1 stays up', (s) => cvm(s, 1).stargate === 'up'),
      hostConnected,
      otherVmsRun,
      neverSeen(END, 'ha.vm.restarted'),
      neverSeen(END, 'vm.force-shutdown'),
      neverSeen(END, 'hades.maintenance.enter'),
      at(END, 'paths come back once the uplinks return', (s) => allPathsLive(cvm(s, 1))),
      allRunningAt(END, 'node 1 VMs resume when the array answers again'),
      ...baseInvariants(),
    ],
    narrative:
      "The same failure with Hades maintenance mode switched off, as a lab comparison. Node 1's CVM loses every NVMe path while Stargate keeps answering the redirector, so the VMs' IO stays with the local CVM and retries until the array responds. Without a per-VM force-shutdown timeout the VMs stall in place, then resume as soon as the uplinks return.",
    cite: ['ntnx-ncp-everpure-deploy-7.6', 'ntnx-bible-5b', 'ntnx-bible-8c'],
    status: 'active',
  });
}

export default [hades(), retryInPlace()];
