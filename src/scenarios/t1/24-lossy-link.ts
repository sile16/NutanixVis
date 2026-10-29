import { defineScenario } from '../define';
import {
  allCvms,
  allPathsLive,
  allVms,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  eventSeen,
  eventsMatching,
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
 * always get through, so no path is declared lost by KATO. IO frames are many packets each: they
 * are often lost, TCP resends them with a doubling timer (RFC 6298), and IO on that path sees
 * multi-second latency outliers. Eventually a command's frame (or its completion) is lost often
 * enough to hit the NVMe IO timeout: the host aborts it, retries it on another path and resets
 * the path, which reconnects. When the loss is removed the path carries its share of IO again.
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
    atCtx(CLEAR_AT, 'IO on the lossy path sees multi-second latency outliers', (_s, ctx) =>
      wasEver(ctx, (s) => vms(s).some((v) => v.ioPendingS >= 3), T0),
    ),
    atCtx(
      CLEAR_AT,
      'eventually an IO times out: the host retries it elsewhere and resets the path',
      (_s, ctx) =>
        eventSeen(ctx, 'nvme.io.timeout', { from: T0 }) &&
        eventsMatching(ctx, 'nvme.path.lost', { from: T0 }).some((e) =>
          e.text.includes('IO timeout'),
        ),
    ),
    atCtx(END, 'no path is ever declared lost by keep-alive', (_s, ctx) =>
      eventsMatching(ctx, 'nvme.path.lost').every((e) => !e.text.includes('keep-alive')),
    ),
    alwaysFrom(T0, 'guests keep running throughout', (s) => allVms(s, isRunning)),
    at(END, 'after the loss is removed every path is live', (s) => allCvms(s, allPathsLive)),
    at(END, 'and the formerly lossy path carries IO again', (s) =>
      T1.nodes.every((n) => pathShare(s, n, lossyPath(n)) > 0),
    ),
    neverSeen(END, 'vm.io.error'),
    neverSeen(END, 'vm.io.guest-timeout'),
    ...baseInvariants(),
  ],
  narrative: `The cable of array port ${FA_PORT} starts losing ${LOSS_PCT} % of its packets while carrier and forwarding stay up, so no path is declared failed: keep-alives are single small packets and get through. IO on that path is many packets per command, so it is often resent with a doubling TCP timer and shows multi-second latency outliers, until a command waits past the NVMe IO timeout and the host retries it elsewhere and resets the path. Once the cable is replaced the path is used again like the others.`,
  cite: ['rfc-6298', 'nvme-base-spec-2.1', 'linux-nvme-host'],
  status: 'active',
});
