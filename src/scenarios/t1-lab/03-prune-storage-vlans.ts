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
  isStalled,
  neverSeen,
  SLACK,
  T0,
  t1Steady,
  vmsOfNode,
} from '../helpers';
import { cvmId, nodeId, T1_LAB } from '../ids';
import { KATO, P } from '../timers';

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
    ...(withTimeout ? { options: { 'path-loss-force-shutdown-s': FORCE_SHUTDOWN_S } } : {}),
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
            at(END, 'VMs stall in place, retrying until the array responds', (s) =>
              vmsOfNode(s, NODE).every((v) => isStalled(v) && v.host === nodeId(NODE)),
            ),
            neverSeen(END, 'vm.force-shutdown'),
            neverSeen(END, 'ha.vm.restarted'),
          ]),
      ...baseInvariants(),
    ],
    narrative: withTimeout
      ? "Both storage VLANs are pruned from node 1's switch port, so its CVM loses every array path while management stays up. The VMs on node 1 have a force-shutdown timeout set, so once it expires they are shut down and restarted on a node that still reaches the array."
      : "Both storage VLANs are pruned from node 1's switch port, so its CVM loses every array path while management stays up and the cluster still sees a healthy host. By default the node retries IO until the array responds, so its VMs stall in place with no HA event.",
    cite: ['ntnx-ncp-everpure-deploy-7.6', 'nvme-base-spec'],
    status: 'active',
  });
}

export default [variant(false), variant(true)];
