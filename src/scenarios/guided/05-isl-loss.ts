/**
 * Guided 5: the inter-switch link starts losing packets (grey failure, no carrier loss). Only IO
 * that crosses the ISL is hurt: two storage vSwitches never cross it, a MAC-pinning node booted
 * home neither, a swapped one in full; LACP hashes some connections across it on the way out.
 * TCP resends only the lost segment, so IO slows (retransmission outliers) but never stalls.
 */
import type { T1Config } from '../../topologies/t1-configs';
import { defineScenario, type ScenarioGuide } from '../define';
import { atCtx, baseInvariants, neverSeen, T0 } from '../helpers';
import { ISLS, T1 } from '../ids';
import { guideChecks } from '../steps';
import {
  ALL_CONFIGS,
  type GuidedFamily,
  guidedId,
  guidedSteady,
  layoutWords,
  peakLatencyMs,
  VM1,
  VM2,
} from './kit';

const LOSS_PCT = 5;
const CLEAR_AT = T0 + 60;
const END = CLEAR_AT + 30;
/** Latency (ms) a retransmission shows at: far above the sub-millisecond steady state. */
const SLOW_MS = 100;
const FAST_MS = 5;

const setLoss = (pct: number, at: number) =>
  ISLS.map((l, i) => ({
    at,
    action: { kind: 'link.set-loss', target: l, params: { pct } },
    ...(i === 0
      ? {
          note:
            pct > 0
              ? `Both ISL links start losing ${LOSS_PCT} % of their packets (carrier stays up).`
              : 'The ISL is repaired: no more loss.',
        }
      : {}),
  }));

/** Which VMs' IO crosses the ISL, per configuration. */
function affected(c: T1Config): { hit: readonly string[]; spared: readonly string[] } {
  if (c.bond === 'none') return { hit: [], spared: [VM1, VM2] };
  if (c.bond === 'mac-pinning' && c.arrayIps === 4) return { hit: [VM2], spared: [VM1] };
  if (c.bond === 'lacp' && c.arrayIps === 4) return { hit: [VM1], spared: [] };
  return { hit: [VM1, VM2], spared: [] };
}

function firstNote(c: T1Config): string {
  if (c.bond === 'none') {
    return 'No storage IO crosses the ISL in this layout: storage-a stays on Switch A with its array ports, storage-b on Switch B. Nothing changes, on any VM.';
  }
  if (c.bond === 'mac-pinning') {
    return c.arrayIps === 4
      ? "Node 2 booted swapped, so all its storage IO crosses the ISL: a packet of nearly every large IO frame is lost and resent, and VM 2-1's latency jumps from well under a millisecond to hundreds of milliseconds. VM 1-1, on a node that booted home, does not notice."
      : "With 8 array IPs about half of every node's IO crosses the ISL, swapped or not: both VMs' latency jumps from well under a millisecond to hundreds of milliseconds.";
  }
  return c.arrayIps === 4
    ? "LACP hashed node 1's connections across the ISL on the way out, so its writes lose packets and are resent: VM 1-1's latency jumps from well under a millisecond to hundreds of milliseconds. Replies never cross (the array port's switch sends them out its own member), so reads are spared."
    : "LACP hashes some of every node's connections across the ISL on the way out: both VMs' writes lose packets and are resent, and their latency jumps from well under a millisecond to hundreds of milliseconds. Replies never cross, so reads are spared.";
}

function build(c: T1Config) {
  const { hit, spared } = affected(c);
  const vm = c.bond === 'mac-pinning' ? VM2 : VM1;
  const name = vm === VM2 ? 'VM 2-1' : 'VM 1-1';
  const guide: ScenarioGuide = {
    vm,
    groups: [
      [
        {
          io: 'none',
          text: `${firstNote(c)}${c.bond === 'none' ? '' : ' Select a VM to see its IO latency.'}`,
        },
        {
          io: 'none',
          text: `${name}'s IO never stalls and no path is lost: keep-alives are single small packets and get through, and TCP resends only the lost segment, which is rarely lost twice. A slow day, not an outage, and nothing in the storage stack reports it.`,
        },
      ],
      [
        {
          io: 'none',
          text:
            hit.length > 0
              ? 'The loss stops and the latency drops back at once.'
              : 'The loss stops; nothing ever changed here.',
        },
      ],
    ],
  };
  return defineScenario({
    id: guidedId(5, 'isl-loss', c.key),
    title: 'Packet loss on the ISL',
    topology: T1.topology,
    options: c.options,
    durationS: END,
    timeline: [...setLoss(LOSS_PCT, T0), ...setLoss(0, CLEAR_AT)],
    expect: [
      ...guidedSteady(),
      ...hit.map((v) =>
        atCtx(
          END,
          `${v}: its IO crosses the ISL and slows down`,
          (_s, ctx) => peakLatencyMs(ctx, v, T0, CLEAR_AT) >= SLOW_MS,
        ),
      ),
      ...spared.map((v) =>
        atCtx(
          END,
          `${v}: its IO never crosses the ISL and keeps its latency`,
          (_s, ctx) => peakLatencyMs(ctx, v, T0, CLEAR_AT) < FAST_MS,
        ),
      ),
      ...hit.map((v) =>
        atCtx(
          END,
          `${v}: back to normal once the loss stops`,
          (_s, ctx) => peakLatencyMs(ctx, v, END - 10, END) < FAST_MS,
        ),
      ),
      neverSeen(END, 'nvme.path.lost'),
      neverSeen(END, 'nvme.io.timeout'),
      neverSeen(END, 'hades.maintenance.enter'),
      ...guideChecks(guide, END),
      ...baseInvariants(),
    ],
    guide,
    narrative: `With ${layoutWords(c)}, both ISL links lose ${LOSS_PCT} % of their packets while carrier stays up. ${
      c.bond === 'none'
        ? 'No storage IO crosses the ISL here, so nothing changes.'
        : c.bond === 'mac-pinning' && c.arrayIps === 4
          ? 'Only node 2, which booted swapped, sends its storage IO across it, and only its VM slows down.'
          : 'IO that crosses it slows down with retransmissions, on every node.'
    } TCP resends only the lost segments, so IO slows but never stalls, and nothing reports the cause.`,
    cite: ['rfc-6298', 'ovs-bonding', 'everpure-nutanix-net-bp', 'nvme-base-spec-2.1'],
    status: 'active',
  });
}

const family: GuidedFamily = {
  n: 5,
  slug: 'isl-loss',
  title: 'Packet loss on the ISL',
  configs: ALL_CONFIGS,
  build,
};
export default family;
