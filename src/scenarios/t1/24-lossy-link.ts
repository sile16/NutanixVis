import { defineScenario } from '../define';
import {
  allCvms,
  allPathsLive,
  allVms,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  isRunning,
  neverSeen,
  pathShare,
  T0,
  t1Steady,
  vms,
  wasEver,
} from '../helpers';
import { linkId, SW_A, T1 } from '../ids';
import { KATO, P } from '../timers';

const FA_PORT = 'fa.ct0.eth10';
const IP = `${FA_PORT}.v10`;
const CABLE = linkId(FA_PORT, SW_A);
const LOSS_PCT = 5;
const CLEAR_AT = T0 + 240;
/** After the loss is removed: a reset path's reconnect, then a full share window (30 s). */
const END = CLEAR_AT + P.externalStorage.reconnectDelayS + KATO + 40;
/** The path from CVM `n`'s VLAN-A storage interface to the lossy FA IP. */
const lossyPath = (n: number) => `${T1.segA(n)}~${IP}`;

/**
 * Grey failure (SPEC §6.4c "Lossy link"). The cable of one FA port drops a share of its packets
 * (`link.set-loss`); carrier and forwarding stay up. Keep-alives are one small packet and almost
 * always get through, so no path is declared lost by KATO. IO frames are many packets each, so
 * one of their packets is often lost; TCP then resends only that segment after its
 * retransmission timer (RFC 6298, SACK), which is lost again only as rarely as any one packet.
 * IO on that path therefore shows latency outliers of a retransmission or two, but every command
 * completes: none reaches the NVMe IO timeout and no path is reset. When the loss is removed the
 * path carries its share of IO as before.
 */
export default defineScenario({
  id: 't1-24-lossy-fa-port-cable',
  title: `T1: grey failure, an array port cable loses ${LOSS_PCT} % of its packets`,
  topology: T1.topology,
  durationS: END,
  timeline: [
    {
      at: T0,
      action: { kind: 'link.set-loss', target: CABLE, params: { pct: LOSS_PCT } },
      note: `The cable of array port ${FA_PORT} starts losing ${LOSS_PCT} % of its packets.`,
    },
    {
      at: CLEAR_AT,
      action: { kind: 'link.set-loss', target: CABLE, params: { pct: 0 } },
      note: 'The bad cable is replaced: no more loss.',
    },
  ],
  expect: [
    ...t1Steady(),
    atCtx(CLEAR_AT, 'IO on the lossy path sees retransmission latency outliers', (_s, ctx) =>
      wasEver(ctx, (s) => vms(s).some((v) => v.ioPendingS >= 2), T0),
    ),
    neverSeen(END, 'nvme.io.timeout'),
    neverSeen(END, 'nvme.path.lost'),
    alwaysFrom(T0, 'guests keep running throughout', (s) => allVms(s, isRunning)),
    at(END, 'after the loss is removed every path is live', (s) => allCvms(s, allPathsLive)),
    at(END, 'and the formerly lossy path carries IO again', (s) =>
      T1.nodes.every((n) => pathShare(s, n, lossyPath(n)) > 0),
    ),
    neverSeen(END, 'vm.io.error'),
    neverSeen(END, 'vm.io.guest-timeout'),
    ...baseInvariants(),
  ],
  narrative: `The cable of array port ${FA_PORT} starts losing ${LOSS_PCT} % of its packets while carrier and forwarding stay up, so no path is declared failed: keep-alives are single small packets and get through. IO on that path is many packets per command, so a packet of it is often lost and TCP resends that segment after its retransmission timer, which shows as latency outliers. Every command still completes, so nothing times out and no path is reset; once the cable is replaced the outliers stop.`,
  cite: ['rfc-6298', 'nvme-base-spec-2.1', 'linux-nvme-host'],
  status: 'active',
});
