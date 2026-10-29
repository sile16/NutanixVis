import { defineScenario } from '../define';
import {
  allRunningAt,
  at,
  atCtx,
  baseInvariants,
  by,
  eventSeen,
  eventsInOrder,
  firstEventAt,
  isRunning,
  neverSeen,
  T0,
  t1Steady,
  vmsOfNode,
} from '../helpers';
import { cvmId, nodeId, T1 } from '../ids';
import { P, REDIRECT_DETECT, SILENT_PAUSE } from '../timers';

/** Node 2: its CVM is not the Acropolis leader, which reaches its own host over this link too. */
const NODE = 2;
const CVM = cvmId(NODE);
const HOST = nodeId(NODE);
const UP = T0 + 60;
const VALID = P.redirector.externalPathValidityS;
const END = UP + VALID + 60;

/**
 * Host–CVM internal link lost (SPEC §6.2 "iSCSI redirector"). The link between node 2's AHV host
 * and its CVM fails; the CVM's cluster network and storage paths stay up.
 * - The host's VM initiators miss their NOPs and log in again through the redirector, which finds
 *   the local portal down and sends them to a peer.
 * - The peer's iSCSI load balancer sends each session on to the vDisk's leader, CVM 2, which is
 *   alive: to its external portal. The same Stargate serves again after about one NOP detection,
 *   with no vDisk handover and no Zookeeper expiry, far quicker than a silent Stargate (T1-27).
 * - When the link returns, the sessions stay on the external path for a long validity window, then
 *   move back to the internal link (no failback cycle).
 */
export default defineScenario({
  id: 't1-30-internal-link-lost',
  title:
    'T1: host–CVM internal link lost — the local Stargate keeps serving over the external path',
  topology: T1.topology,
  durationS: END,
  timeline: [
    {
      at: T0,
      action: { kind: 'cvm.internal-link-down', target: CVM },
      note: "The internal link between node 2's host and CVM 2 fails; CVM 2's cluster network and storage stay up.",
    },
    {
      at: UP,
      action: { kind: 'cvm.internal-link-up', target: CVM },
      note: 'The internal link returns.',
    },
  ],
  expect: [
    ...t1Steady(),
    atCtx(by(REDIRECT_DETECT), 'the initiators notice by their NOPs and log in again', (_s, ctx) =>
      eventSeen(ctx, 'redirector.unhealthy', { device: HOST }),
    ),
    atCtx(
      by(REDIRECT_DETECT),
      "a peer sends the sessions on to CVM 2's external portal (it is alive)",
      (_s, ctx) => eventSeen(ctx, 'redirector.leader-redirect', { device: HOST }),
    ),
    at(by(REDIRECT_DETECT + 2), 'node 2 VMs run again, served by CVM 2 (no vDisk handover)', (s) =>
      vmsOfNode(s, NODE).every((v) => isRunning(v) && v.host === HOST && v.ownerCvm === CVM),
    ),
    atCtx(
      by(REDIRECT_DETECT + 2),
      'IO resumes well before a silent Stargate would be replaced',
      (_s, ctx) => {
        const t = firstEventAt(ctx, 'redirector.leader-redirect', { device: HOST });
        return t !== null && t < T0 + SILENT_PAUSE;
      },
    ),
    neverSeen(END, 'redirector.parked'),
    neverSeen(END, 'stargate.zk-session-lost'),
    neverSeen(END, 'vm.crashed'),
    neverSeen(END, 'ha.host.disconnected'),
    atCtx(
      UP + VALID - 30,
      'after the link returns the sessions stay on the external path (no failback cycle)',
      (_s, ctx) =>
        firstEventAt(ctx, 'redirector.path-internal', { device: HOST }) === null &&
        firstEventAt(ctx, 'redirector.failback', { device: HOST }) === null,
    ),
    atCtx(END, 'they move back to the internal link after the validity window', (_s, ctx) => {
      const t = firstEventAt(ctx, 'redirector.path-internal', { device: HOST });
      return t !== null && t >= UP + VALID;
    }),
    atCtx(
      END,
      'order: link down, NOP miss, leader redirect, link up, back to internal',
      (_s, ctx) =>
        eventsInOrder(ctx, [
          { code: 'cvm.internal-link.down', device: CVM },
          { code: 'redirector.unhealthy', device: HOST },
          { code: 'redirector.leader-redirect', device: HOST },
          { code: 'cvm.internal-link.up', device: CVM },
          { code: 'redirector.path-internal', device: HOST },
        ]),
    ),
    allRunningAt(END),
    ...baseInvariants(),
  ],
  narrative:
    "The internal link between node 2's host and CVM 2 fails while CVM 2's cluster network and storage stay up. Node 2's VM initiators miss their NOPs and log in again through the redirector to a peer, whose iSCSI load balancer sends each session on to the vDisk's leader, CVM 2, at its external portal, since CVM 2 is alive. So the same Stargate serves again after about one NOP detection, with no vDisk handover and no Zookeeper expiry. When the link returns, the sessions stay on the external path for a long validity window before moving back to the internal link.",
  cite: ['ntnx-bible-5b'],
  status: 'active',
});
