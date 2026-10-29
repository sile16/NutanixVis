import { defineScenario, type ScenarioDef } from '../define';
import {
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  by,
  cvmPathsUp,
  eventSeen,
  eventsMatching,
  host,
  isRunning,
  neverSeen,
  SLACK,
  T0,
  t1Steady,
  vmsOfNode,
} from '../helpers';
import { cvmId, nodeId, T1_LAB } from '../ids';
import { HADES_DETECT, KATO, P, REDIRECT_PAUSE, VDISK_HANDOVER } from '../timers';

const NODE = 1;
/** A per-VM force-shutdown value for the "with" variant (the default is unset). */
const FORCE_SHUTDOWN_S = 60;

function variant(withTimeout: boolean): ScenarioDef {
  const END = withTimeout ? by(KATO + FORCE_SHUTDOWN_S + P.ahvHa.restartByS) + 10 : T0 + 240;
  return defineScenario({
    id: `t1lab-03-prune-storage-vlans-${withTimeout ? 'force-shutdown' : 'default'}`,
    title: `T1-lab: prune the storage VLANs on one node's switch port (${withTimeout ? 'per-VM force-shutdown set' : 'default path-loss handling'})`,
    topology: T1_LAB.topology,
    // `path-loss-force-shutdown-s` is a proposed option (per-VM schema field, applied to all VMs).
    // The force-shutdown variant switches Hades maintenance off: with it on, the node enters
    // maintenance within HADES_DETECT and its VMs move before any per-VM timeout could fire, so
    // the per-VM path-loss handling (DEPLOY-GUIDE) is only visible without it.
    ...(withTimeout
      ? {
          options: {
            'path-loss-force-shutdown-s': FORCE_SHUTDOWN_S,
            'hades-maintenance-on-storage-error': 'off',
          },
        }
      : {}),
    durationS: END,
    timeline: [10, 20].map((vlan) => ({
      at: T0,
      action: { kind: 'switch.port.prune-vlan', target: T1_LAB.nicLink(NODE), params: { vlan } },
      note: `Prune VLAN ${vlan} from node ${NODE}'s switch port.`,
    })),
    expect: [
      ...t1Steady(),
      atCtx(
        by(KATO),
        `CVM ${NODE} loses every array path`,
        (s, ctx) =>
          cvmPathsUp(s, NODE) === 0 &&
          eventSeen(ctx, 'nvme.all-paths.lost', { device: cvmId(NODE) }),
      ),
      alwaysFrom(
        T0,
        'management stays up: the host is never disconnected',
        (s) => host(s, NODE).haState === 'connected',
      ),
      ...(withTimeout
        ? [
            atCtx(END, 'each VM is force-shut down after the timeout, not before', (s, ctx) =>
              vmsOfNode(s, NODE).every((v) => {
                const e = eventsMatching(ctx, 'vm.force-shutdown', { device: v.id })[0];
                return (
                  e !== undefined &&
                  e.t >= T0 + FORCE_SHUTDOWN_S - SLACK &&
                  e.t <= by(KATO + FORCE_SHUTDOWN_S)
                );
              }),
            ),
            at(END, 'and restarted on a node with array connectivity', (s) =>
              vmsOfNode(s, NODE).every((v) => isRunning(v) && v.host !== nodeId(NODE)),
            ),
          ]
        : [
            // Default (`inferred`): the CVM also lost its service volumes, so Hades puts the
            // node in maintenance mode and the redirector moves its VMs' IO.
            atCtx(by(HADES_DETECT), 'Hades puts the node in maintenance mode', (_s, ctx) =>
              eventSeen(ctx, 'hades.maintenance.enter', { device: cvmId(NODE) }),
            ),
            at(END, 'VMs keep running in place, served by a remote Stargate', (s) =>
              vmsOfNode(s, NODE).every(
                (v) => isRunning(v) && v.host === nodeId(NODE) && v.ownerCvm !== cvmId(NODE),
              ),
            ),
            alwaysFrom(
              T0,
              'VM IO pause bounded by Hades detection, the redirect and the vDisk handover',
              (s) =>
                vmsOfNode(s, NODE).every(
                  (v) => v.ioPendingS <= HADES_DETECT + REDIRECT_PAUSE + VDISK_HANDOVER + SLACK,
                ),
            ),
            // The redirect lands well before the guest's 60 s disk timeout.
            neverSeen(END, 'vm.io.guest-timeout'),
            neverSeen(END, 'vm.force-shutdown'),
            neverSeen(END, 'ha.vm.restarted'),
          ]),
      ...baseInvariants(),
    ],
    narrative: withTimeout
      ? "Both storage VLANs are pruned from node 1's switch port, so its CVM loses every array path while management stays up. The VMs on node 1 have a force-shutdown timeout set, so once it expires they are shut down and restarted on a node that still reaches the array."
      : "Both storage VLANs are pruned from node 1's switch port, so its CVM loses every array path while management stays up and the cluster still sees a healthy host. The CVM has also lost its Zookeeper and Cassandra service volumes, so seconds after keep-alive declares the paths lost Hades puts the node in maintenance mode and its Stargate stops. The redirector moves the VMs' sessions to a CVM that still reaches the array, which takes the vDisks over at once, so they keep running in place with no guest timeout and no HA event.",
    cite: ['ntnx-ncp-everpure-deploy-7.6', 'nvme-base-spec', 'ntnx-cmdref-aos-7.6'],
    status: 'active',
  });
}

export default [variant(false), variant(true)];
