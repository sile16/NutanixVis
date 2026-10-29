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
  eventsInOrder,
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
import {
  HADES_DETECT,
  HADES_EARLIEST,
  HADES_EXIT,
  HADES_RECOVER,
  KATO,
  P,
  REDIRECT_DETECT,
  REDIRECT_PAUSE,
  VDISK_HANDOVER,
} from '../timers';

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
 * on the array too. Sequence (fast → slow, SPEC §14 #12): the paths fail silently and the guest
 * stalls; keep-alive declares them lost after KATO; Hades sees the mounts fail at its next check
 * and puts node 1 in maintenance mode once the error has lasted the 5 s threshold (HADES_DETECT,
 * never before HADES_EARLIEST); its Stargate stops and the redirector moves the VMs' sessions to
 * a CVM that still reaches the array within REDIRECT_DETECT; the remote Stargate takes the vDisks
 * over about at once (VDISK_HANDOVER) and IO resumes, well inside the guest's 60 s disk timeout.
 * After the uplinks return the controllers reconnect, the next volume check takes the node out of
 * maintenance (HADES_EXIT, seconds, not the 300 s re-map), the services restart, and only after
 * the redirector's 300 s stable window do the sessions fail back.
 */
function hades(): ScenarioDef {
  const END =
    by(
      HADES_RECOVER +
        P.redirector.failbackStableS +
        P.redirector.redirectStallS +
        P.redirector.nopIntervalS,
      RESTORE_AT,
    ) + 5;
  const IO_PAUSE = HADES_DETECT + REDIRECT_PAUSE + VDISK_HANDOVER;
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
      atCtx(
        by(HADES_DETECT),
        'Hades puts node 1 in maintenance mode: path-loss detection plus the 5 s threshold',
        (_s, ctx) => {
          const t = firstEventAt(ctx, 'hades.maintenance.enter', { device: CVM });
          return t !== null && t >= T0 + HADES_EARLIEST;
        },
      ),
      atCtx(
        by(HADES_DETECT + REDIRECT_DETECT),
        'the redirect follows within seconds of maintenance',
        (_s, ctx) => {
          const enter = firstEventAt(ctx, 'hades.maintenance.enter', { device: CVM });
          const redirect = firstEventAt(ctx, 'redirector.redirect', { device: nodeId(1) });
          return enter !== null && redirect !== null && redirect - enter <= REDIRECT_DETECT + SLACK;
        },
      ),
      at(by(IO_PAUSE), 'node 1 VMs run on a remote Stargate: IO resumed at once', (s) =>
        vmsOfNode(s, 1).every(
          (v) => isRunning(v) && v.host === nodeId(1) && v.ownerCvm !== null && v.ownerCvm !== CVM,
        ),
      ),
      atCtx(
        by(IO_PAUSE),
        'order: paths lost, maintenance, redirect, handover, IO served remotely',
        (_s, ctx) =>
          eventsInOrder(ctx, [
            { code: 'nvme.all-paths.lost', device: CVM },
            { code: 'hades.maintenance.enter', device: CVM },
            { code: 'redirector.redirect', device: nodeId(1) },
            { code: 'stargate.vdisk.handover' },
            { code: 'stargate.vdisk.taken-over' },
          ]),
      ),
      alwaysFrom(T0, 'node 1 VM IO pause bounded by Hades detection and the redirect', (s) =>
        vmsOfNode(s, 1).every((v) => v.ioPendingS <= IO_PAUSE + SLACK),
      ),
      // The redirect lands well before the guest's 60 s SCSI timeout.
      neverSeen(END, 'vm.io.guest-timeout'),
      hostConnected,
      otherVmsRun,
      atCtx(
        END,
        'node 1 leaves maintenance at the volume check after the paths return, then services restart',
        (_s, ctx) => {
          const exit = firstEventAt(ctx, 'hades.maintenance.exit', { device: CVM });
          const up = firstEventAt(ctx, 'stargate.up', { device: CVM, from: RESTORE_AT });
          return (
            exit !== null &&
            exit > RESTORE_AT &&
            exit <= by(HADES_EXIT, RESTORE_AT) &&
            up === exit + P.hades.servicesRestartS
          );
        },
      ),
      atCtx(
        END,
        'failback waits the 300 s stable window: far slower than the failover',
        (_s, ctx) => {
          const enter = firstEventAt(ctx, 'hades.maintenance.enter', { device: CVM });
          const redirect = firstEventAt(ctx, 'redirector.redirect', { device: nodeId(1) });
          const up = firstEventAt(ctx, 'stargate.up', { device: CVM, from: RESTORE_AT });
          const back = firstEventAt(ctx, 'redirector.failback', { device: nodeId(1) });
          if (enter === null || redirect === null || up === null || back === null) return false;
          return back - up >= P.redirector.failbackStableS && back - up > 10 * (redirect - enter);
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
      "Node 1 loses both vs1 uplinks but keeps management on vs0, so the cluster still sees the host as healthy. Its CVM's NVMe paths fail silently and the VMs' IO stalls; keep-alive declares every path lost, including the ones to its own Zookeeper and Cassandra service volumes, so 5 s later Hades puts the node in maintenance mode and stops its Stargate. Within seconds the redirector moves the VMs' sessions to a CVM that still reaches the array, which takes the vDisks over at once: IO resumes well inside the guest disk timeout, with no HA event. After the uplinks return the controllers reconnect, the next volume check takes the node out of maintenance and its services restart; the sessions fail back only after the redirector's 300 s stable window.",
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
