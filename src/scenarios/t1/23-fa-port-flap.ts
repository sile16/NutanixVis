import { defineScenario, type ScenarioDef } from '../define';
import {
  allCvms,
  allPathsLive,
  allVms,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  by,
  eventsInOrder,
  eventsMatching,
  isRunning,
  isStalled,
  neverSeen,
  SLACK,
  T0,
  t1Steady,
} from '../helpers';
import { T1 } from '../ids';
import { KATO, P, PATH_LOSS_WORST } from '../timers';

const IP = 'fa.ct0.eth10.v10';
/** Retransmission and reset round trip after the port returns (ticks). */
const RESET_SLACK = 2;

/**
 * SPEC §6.4c "Short port flap". The FA port behind `IP` loses link and returns. The target drops
 * the port's NVMe/TCP connections when it loses link (`assumption`), so when it returns the
 * hosts' next retransmission on an old connection gets a TCP reset. That proves the target holds
 * none of the stuck commands, so they are retried at once (`targetResetRetryS`) instead of waiting
 * out the lost-path hold: the guest stall is about the outage. The initiator then runs a normal
 * reconnect cycle (`reconnectDelayS`). A queue depth of 4 makes the guest stall visibly.
 * - 3 s (shorter than KATO): the path is never declared dead; the reset itself loses it.
 * - 20 s (longer than the hold): keep-alive declares it lost first, and the held commands are
 *   retried on the other paths when the hold ends, while the port is still down.
 */
function variant(outage: 3 | 20): ScenarioDef {
  const short = outage < KATO;
  const back = T0 + 1 + outage;
  const resumeBy = short ? back + RESET_SLACK : T0 + 1 + PATH_LOSS_WORST + SLACK;
  const END = Math.max(resumeBy, back) + P.externalStorage.reconnectDelayS + KATO + 20;
  return defineScenario({
    id: `t1-23-fa-port-flap-${outage}s`,
    title: `T1: an array port flaps for ${outage} s`,
    topology: T1.topology,
    options: { 'guest-queue-depth': 4 },
    durationS: END,
    timeline: [
      {
        at: T0,
        action: { kind: 'fa.interface.flap', target: IP, params: { durationS: outage } },
        note: `The port behind ${IP} loses link for ${outage} s.`,
      },
    ],
    expect: [
      ...t1Steady(),
      at(T0 + 3, 'during the outage the guests stall on the dead path', (s) =>
        allVms(s, isStalled),
      ),
      at(
        resumeBy,
        short
          ? 'once the port is back the stuck IO is retried at once; guests run'
          : 'the hold ends while the port is still down: the stuck IO runs on the other paths',
        (s) => allVms(s, isRunning),
      ),
      alwaysFrom(
        T0,
        short
          ? 'the guest stall is about the outage, below the lost-path hold'
          : 'the guest stall is at most the lost-path hold',
        (s) =>
          allVms(s, (v) =>
            short
              ? v.ioPendingS <= resumeBy - T0 + SLACK && v.ioPendingS < PATH_LOSS_WORST
              : v.ioPendingS <= PATH_LOSS_WORST + SLACK,
          ),
      ),
      ...(short
        ? [
            atCtx(
              back + RESET_SLACK,
              'the target reset the old connections: path lost by reset',
              (_s, ctx) =>
                eventsMatching(ctx, 'nvme.path.lost').every(
                  (e) => e.t >= back && e.text.includes('reset the connection'),
                ) && eventsMatching(ctx, 'nvme.path.lost').length > 0,
            ),
          ]
        : [
            atCtx(by(KATO), 'keep-alive declares the path lost during the outage', (_s, ctx) =>
              eventsMatching(ctx, 'nvme.path.lost').some((e) => e.text.includes('keep-alive')),
            ),
            atCtx(
              END,
              'the hold ended before the port returned: no stuck command was left to release',
              (_s, ctx) => eventsMatching(ctx, 'nvme.io.released').length === 0,
            ),
          ]),
      atCtx(END, 'order: link down, link up, path reset or lost, reconnected', (_s, ctx) =>
        eventsInOrder(ctx, [
          { code: 'net.link.down' },
          { code: 'net.link.up' },
          { code: short ? 'nvme.path.lost' : 'nvme.path.restored' },
          { code: 'nvme.path.restored' },
        ]),
      ),
      at(END, 'every path is live again', (s) => allCvms(s, allPathsLive)),
      neverSeen(END, 'vm.io.guest-timeout'),
      neverSeen(END, 'nvme.io.timeout'),
      ...baseInvariants(),
    ],
    narrative: short
      ? `The array port behind ${IP} loses link for ${outage} s, shorter than the keep-alive timeout. The target drops that port's NVMe/TCP connections, so when the port returns the hosts' next retransmission is answered with a TCP reset. That proves the target holds none of the stuck commands, so they are retried at once and the guest stall is about the outage; the initiator then reconnects the path normally.`
      : `The array port behind ${IP} loses link for ${outage} s, longer than the keep-alive timeout, so every CVM declares its path to it lost and holds the stuck commands. The hold ends before the port returns, so the stuck commands are retried on the other paths and the guests run on while the port is still down; the path reconnects after the port returns.`,
    cite: ['nvme-base-spec-2.1', 'nvme-tcp-spec', 'rfc-6298'],
    status: 'active',
  });
}

export default [variant(3), variant(20)];
