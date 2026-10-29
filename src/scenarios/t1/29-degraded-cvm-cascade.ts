import { defineScenario, type ScenarioDef } from '../define';
import {
  allRunningAt,
  at,
  atCtx,
  baseInvariants,
  by,
  cvm,
  eventSeen,
  eventsInOrder,
  firstEventAt,
  isRunning,
  neverSeen,
  T0,
  t1Steady,
  vms,
  vmsOfNode,
} from '../helpers';
import { cvmId, nodeId, T1 } from '../ids';
import { P, STARGATE_DOWN } from '../timers';

const LOSSY = cvmId(1);
const PEERS = [2, 3, 4].map(cvmId);

type Mode = 'light' | 'heavy';

/** Below `dnd.partialLossPct`: outlier scores only. At or above: half reachable. */
const LOSS: Readonly<Record<Mode, number>> = { light: 30, heavy: 50 };

const HUNG_OP = P.cluster.stargateHungOpS;
const CRASH_BY = T0 + HUNG_OP + P.redirector.initiatorSessionTimeoutS;
const DEGRADED_AT = T0 + P.dnd.partialConvictionS;
const END_HEAVY =
  DEGRADED_AT + P.cluster.stargateSelfRestartS + 2 * P.ahvHa.heartbeatIntervalS + 60;
const END_LIGHT = T0 + P.dnd.partialConvictionS + 30;

/**
 * A degraded (half-reachable) CVM against a dead one (SPEC §6.2 "Degraded Node Detection").
 * CVM 1's inter-CVM interface starts dropping packets; it keeps running and its storage paths stay
 * up.
 * - `light`: below `dnd.partialLossPct`. Its peers score it as an outlier; nothing else happens.
 * - `heavy`: it is half reachable. Its own Stargate drops out when its Zookeeper session expires,
 *   so node 1's VMs move to other Stargates, as for a dead CVM. But it keeps its metadata role,
 *   so every peer Stargate's operations that touch it hang; after `cluster.stargateHungOpS` they
 *   fail fast together and stay down. No Stargate serves, so at the initiator session timeout
 *   every VM in the cluster crashes. Only after `dnd.partialConvictionS` does Degraded Node
 *   Detection mark CVM 1 Degraded (metadata store off, leadership given up); the peer Stargates
 *   then restart and AHV powers the VMs back on. CVM 1 stays Degraded until an operator marks it
 *   fixed. A CVM that is fully cut off instead is treated as dead: its leadership expires and the
 *   peers serve (T1-27, T2-13).
 */
function variant(mode: Mode): ScenarioDef {
  const heavy = mode === 'heavy';
  const END = heavy ? END_HEAVY : END_LIGHT;
  return defineScenario({
    id: `t1-29-degraded-cvm-${mode}-loss`,
    title: heavy
      ? 'T1: a half-reachable CVM takes every Stargate down before it is marked Degraded'
      : 'T1: light packet loss on one CVM only makes it an outlier',
    topology: T1.topology,
    durationS: END,
    timeline: [
      {
        at: T0,
        action: { kind: 'cvm.network-loss', target: LOSSY, params: { pct: LOSS[mode] } },
        note: `CVM 1's inter-CVM interface starts dropping ${LOSS[mode]} % of its packets.`,
      },
    ],
    expect: [
      ...t1Steady(),
      ...(heavy
        ? [
            atCtx(
              by(STARGATE_DOWN),
              "CVM 1's Stargate drops out at its ZK session expiry",
              (_s, ctx) => eventSeen(ctx, 'stargate.zk-session-lost', { device: LOSSY }),
            ),
            at(
              T0 + HUNG_OP - 5,
              'before the hung-op threshold, node 1 VMs run on peer Stargates, still on node 1',
              (s) =>
                vmsOfNode(s, 1).every(
                  (v) => isRunning(v) && v.host === nodeId(1) && v.ownerCvm !== LOSSY,
                ),
            ),
            atCtx(
              T0 + HUNG_OP + 3,
              'every peer Stargate fails fast on operations hung on CVM 1',
              (_s, ctx) =>
                PEERS.every((p) => {
                  const t = firstEventAt(ctx, 'stargate.hung-op-fail-fast', { device: p });
                  return t !== null && t >= T0 + HUNG_OP;
                }),
            ),
            atCtx(
              CRASH_BY + 3,
              'with no Stargate serving, every VM crashes at the initiator session timeout',
              (s, ctx) => vms(s).every((v) => eventSeen(ctx, 'vm.crashed', { device: v.id })),
            ),
            atCtx(
              DEGRADED_AT + 3,
              'Degraded Node Detection marks CVM 1 Degraded only after the VMs have crashed',
              (s, ctx) => {
                const d = firstEventAt(ctx, 'dnd.node.degraded', { device: LOSSY });
                const c = firstEventAt(ctx, 'vm.crashed');
                return d !== null && c !== null && c < d && cvm(s, 1).dndState === 'degraded';
              },
            ),
            atCtx(END, 'the peer Stargates restart and AHV powers every VM back on', (s, ctx) =>
              vms(s).every((v) => eventSeen(ctx, 'ha.vm.restarted', { device: v.id })),
            ),
            at(END, 'CVM 1 is still Degraded', (s) => cvm(s, 1).dndState === 'degraded'),
            atCtx(
              END,
              'order: lossy, own Stargate out, peers fail fast, VMs crash, Degraded',
              (_s, ctx) =>
                eventsInOrder(ctx, [
                  { code: 'cvm.network.lossy', device: LOSSY },
                  { code: 'stargate.zk-session-lost', device: LOSSY },
                  { code: 'stargate.hung-op-fail-fast' },
                  { code: 'vm.crashed' },
                  { code: 'dnd.node.degraded', device: LOSSY },
                  { code: 'ha.vm.restarted' },
                ]),
            ),
            allRunningAt(END),
          ]
        : [
            atCtx(T0 + 2, 'its peers score it as an outlier', (_s, ctx) =>
              eventSeen(ctx, 'dnd.outlier', { device: LOSSY }),
            ),
            neverSeen(END, 'stargate.zk-session-lost'),
            neverSeen(END, 'stargate.hung-op-fail-fast'),
            neverSeen(END, 'vm.crashed'),
            neverSeen(END, 'dnd.node.degraded'),
            allRunningAt(END),
          ]),
      ...baseInvariants(),
    ],
    narrative: heavy
      ? `CVM 1's inter-CVM interface drops ${LOSS.heavy} % of its packets, leaving it half reachable: its own Stargate drops out at its Zookeeper session expiry and node 1's VMs move to other Stargates, as for a dead CVM. But CVM 1 keeps its metadata role, so the peer Stargates' operations that touch it hang, and after about a minute they all fail fast and stay down. With no Stargate serving anywhere, every VM in the cluster crashes at the initiator session timeout. Only minutes later does Degraded Node Detection mark CVM 1 Degraded; the peer Stargates then restart and AHV powers the VMs back on, while CVM 1 stays Degraded until an operator marks it fixed.`
      : `CVM 1's inter-CVM interface drops ${LOSS.light} % of its packets. Its peers score it as an outlier, but nothing else changes: its Stargate keeps its Zookeeper session, no operation hangs, IO is unaffected and the node is not marked Degraded.`,
    cite: ['ntnx-community-dnd', 'ntnx-bible-5b', 'ntnx-pe-alerts-7.0-cvm'],
    status: 'active',
  });
}

export default [variant('light'), variant('heavy')];
