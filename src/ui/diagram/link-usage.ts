/**
 * Link speed labels (pure). From the throughput model's per-direction link loads (`flow-data.ts`,
 * docs/research/link-congestion.md): the Gb/s each way with an arrow for the direction as drawn
 * (`↓21 ↑50`; the legend names the unit), and on the ISL the share of all storage IO that crosses.
 * The % of line rate is drawn as bars (`meters.ts`); a busy or full direction colors the label, and
 * the hover text spells out each direction, its share of line rate and any queueing delay.
 */
import type { Snapshot } from '../../engine/types';
import { type DirUsage, portChannelUsage } from './flow-data';
import { islGroups } from './isl-share';
import { buildMeters } from './meters';

export { type DirUsage, FLOWS_DEVICE, linkUsage } from './flow-data';

export type UsageTone = 'ok' | 'busy' | 'full';

export interface LinkUsageLabel {
  /** One or two lines (`\n`). */
  readonly text: string;
  /** Hover text: each direction in full. */
  readonly title: string;
  readonly tone: UsageTone;
  /** Busiest direction's share of line rate, 0..1. */
  readonly util: number;
}

const FULL_UTIL = 0.97;
const BUSY_UTIL = 0.8;

const toneOf = (d: DirUsage): UsageTone =>
  d.delayUs > 2 || d.dropGbps > 0 || d.gbps >= FULL_UTIL * d.capacityGbps
    ? 'full'
    : d.gbps >= BUSY_UTIL * d.capacityGbps
      ? 'busy'
      : 'ok';

const rank: Readonly<Record<UsageTone, number>> = { ok: 0, busy: 1, full: 2 };
const fmt = (g: number) =>
  g >= 10 ? Math.round(g).toString() : (Math.round(g * 10) / 10).toString();

/** Edge labels for every cable that carries storage throughput, and always the ISL. */
export function linkUsageLabels(snapshot: Snapshot): Map<string, LinkUsageLabel> {
  const out = new Map<string, LinkUsageLabel>();
  const usage = portChannelUsage(snapshot, islGroups(snapshot));
  if (!usage) return out;
  const kind = (id: string) => snapshot.devices[id]?.kind;
  const meters = buildMeters(snapshot);
  const endOf = (dirs: readonly DirUsage[]) =>
    dirs.find((d) => kind(d.from) !== 'switch')?.from ?? dirs[0]?.to ?? '';
  const totalVm = Object.values(snapshot.devices)
    .filter((d) => d.kind === 'vm')
    .reduce(
      (s, d) => s + (typeof d.fields.throughputGbps === 'number' ? d.fields.throughputGbps : 0),
      0,
    );
  for (const [linkId, dirs] of usage) {
    const between = dirs.every((d) => kind(d.from) === 'switch' && kind(d.to) === 'switch');
    // The ISL is always labeled (0 % is the point of some designs); other cables once busy.
    if (dirs.length === 0 || (!between && dirs.every((d) => d.gbps < 0.05))) continue;
    const tone = dirs.reduce<UsageTone>(
      (t, d) => (rank[toneOf(d)] > rank[t] ? toneOf(d) : t),
      'ok',
    );
    const util = Math.max(...dirs.map((d) => (d.capacityGbps > 0 ? d.gbps / d.capacityGbps : 0)));
    const delay = Math.max(...dirs.map((d) => d.delayUs));
    // Speeds only, with the direction as drawn: ↓ / ↑ on node and array cables (hosts above
    // the switches, the array below), → / ← on the ISL. The bars show % of line rate.
    const meter = meters.line.get(between ? linkId : endOf(dirs));
    const speeds = (meter?.dirs ?? []).map((d) => `${d.arrow}${fmt(d.gbps)}`).join(' ');
    const lines = (meter?.dirs ?? []).map(
      (d) =>
        `${d.arrow} ${fmt(d.gbps)} of ${fmt(meter?.capacityGbps ?? 0)} Gb/s (${Math.round(100 * Math.min(1, d.util))}% of line rate)`,
    );
    if (delay > 0.5) lines.push(`full: queueing adds ${Math.round(delay)} µs`);
    let text = speeds;
    if (between && totalVm > 0) {
      const crossing = dirs.reduce((s, d) => s + d.gbps, 0);
      text += `\n${Math.round((100 * crossing) / totalVm)}% of storage IO crosses`;
    }
    out.set(linkId, { text, title: lines.join('\n'), tone, util });
  }
  return out;
}
