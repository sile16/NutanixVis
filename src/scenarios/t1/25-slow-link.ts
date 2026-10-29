import { defineScenario, type ScenarioDef } from '../define';
import {
  allCvms,
  allPathsLive,
  allVms,
  alwaysFrom,
  at,
  baseInvariants,
  isRunning,
  neverSeen,
  pathLatencyMs,
  pathShare,
  T0,
  t1Steady,
} from '../helpers';
import { linkId, SW_A, T1 } from '../ids';

const FA_PORT = 'fa.ct0.eth10';
const IP = `${FA_PORT}.v10`;
const CABLE = linkId(FA_PORT, SW_A);
const ADDED_MS = 5;
/** A full 30 s path-share window after the latency is added. */
const SETTLED = T0 + 40;
const END = SETTLED + 20;
const slowPath = (n: number) => `${T1.segA(n)}~${IP}`;
/** Its VLAN-A sibling to the other controller, on the same switch and storage interface. */
const fastPath = (n: number) => `${T1.segA(n)}~fa.ct1.eth10.v10`;

/**
 * Slow link (SPEC §6.4c "Slow link"). One FA port cable gets `ADDED_MS` of extra latency
 * (`set-latency`, illustrative). IO on that path completes later by the added latency (once on
 * the way out, once on the way back). The queue-depth selector sends each command to the path
 * with the fewest outstanding commands; a slower path drains its queue more slowly, so it holds
 * more and gets proportionally less new IO, but it is still used. Round-robin ignores latency
 * and keeps an equal share.
 */
function variant(selector: 'queue-depth' | 'round-robin'): ScenarioDef {
  const qd = selector === 'queue-depth';
  return defineScenario({
    id: `t1-25-slow-fa-port-cable-${selector}`,
    title: `T1: one array port cable adds ${ADDED_MS} ms of latency (${selector} selector)`,
    topology: T1.topology,
    options: { 'nvme-path-selector': selector },
    durationS: END,
    timeline: [
      {
        at: T0,
        action: { kind: 'set-latency', target: CABLE, params: { ms: ADDED_MS } },
        note: `The cable of array port ${FA_PORT} gets ${ADDED_MS} ms of extra latency.`,
      },
    ],
    expect: [
      ...t1Steady(),
      at(SETTLED, `IO on the slow path takes at least ${ADDED_MS} ms longer`, (s) =>
        T1.nodes.every((n) => {
          const slow = pathLatencyMs(s, n, slowPath(n));
          const fast = pathLatencyMs(s, n, fastPath(n));
          return slow !== null && fast !== null && slow >= fast + ADDED_MS;
        }),
      ),
      ...(qd
        ? [
            at(SETTLED, 'the selector shifts share to the faster paths', (s) =>
              T1.nodes.every(
                (n) => pathShare(s, n, slowPath(n)) < pathShare(s, n, fastPath(n)) / 4,
              ),
            ),
            at(SETTLED, 'but keeps using the slow one', (s) =>
              T1.nodes.every((n) => pathShare(s, n, slowPath(n)) > 0),
            ),
          ]
        : [
            at(SETTLED, 'round-robin keeps an equal share on the slow path', (s) =>
              T1.nodes.every(
                (n) => Math.abs(pathShare(s, n, slowPath(n)) - pathShare(s, n, fastPath(n))) < 10,
              ),
            ),
          ]),
      alwaysFrom(
        T0,
        'no path is lost and every VM keeps running',
        (s) => allCvms(s, allPathsLive) && allVms(s, isRunning),
      ),
      neverSeen(END, 'nvme.path.lost'),
      ...baseInvariants(),
    ],
    narrative: qd
      ? `The cable of array port ${FA_PORT} gets ${ADDED_MS} ms of extra latency, a slow but working link. IO on that path takes longer by the added latency, so its commands stay outstanding longer and the queue-depth selector, which picks the path with the fewest outstanding commands, sends it a much smaller share of new IO. It never stops using the slow path, and nothing is declared failed.`
      : `The same slow link under the round-robin selector. Round-robin takes every live path in turn whatever its latency, so the slow path keeps its full share and a quarter of the IO pays the extra ${ADDED_MS} ms each way.`,
    cite: ['spdk-bdev-nvme-src', 'everpure-linux-dm-multipath', 'everpure-nvme-tcp-bp'],
    status: 'active',
  });
}

export default [variant('queue-depth'), variant('round-robin')];
