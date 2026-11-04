/**
 * Link usage labels (pure). Reads the throughput model's per-direction link loads (the `flows`
 * device, `links` field: docs/research/link-congestion.md) and turns them into edge labels:
 * Gb/s each way, a tone for busy and full directions, and the queueing delay a full direction
 * adds. Between switches the label also says what share of all storage IO crosses.
 */
import type { Snapshot } from '../../engine/types';

export const FLOWS_DEVICE = 'flows';

export interface DirUsage {
  readonly from: string;
  readonly to: string;
  readonly gbps: number;
  readonly capacityGbps: number;
  readonly delayUs: number;
  readonly dropGbps: number;
}

export type UsageTone = 'ok' | 'busy' | 'full';

export interface LinkUsageLabel {
  readonly text: string;
  readonly tone: UsageTone;
  /** Busiest direction's share of line rate, 0..1. */
  readonly util: number;
}

/** Per-link direction loads, or null when the topology has no throughput model. */
export function linkUsage(snapshot: Snapshot): ReadonlyMap<string, readonly DirUsage[]> | null {
  const raw = snapshot.devices[FLOWS_DEVICE]?.fields.links;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, DirUsage[]>;
    return new Map(Object.entries(parsed));
  } catch {
    return null;
  }
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
const shortSwitch = (label: string) => label.replace(/^Switch\s+/i, '');

/** Edge labels for every cable that carries storage throughput. */
export function linkUsageLabels(snapshot: Snapshot): Map<string, LinkUsageLabel> {
  const out = new Map<string, LinkUsageLabel>();
  const usage = linkUsage(snapshot);
  if (!usage) return out;
  const kind = (id: string) => snapshot.devices[id]?.kind;
  const label = (id: string) => snapshot.devices[id]?.label ?? id;
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
    const tail = tone === 'full' && delay > 0 ? ` · full, +${Math.round(delay)} µs` : '';
    let text: string;
    if (between) {
      const cap = dirs[0]?.capacityGbps ?? 0;
      const each = dirs
        .map((d) => `${shortSwitch(label(d.from))}→${shortSwitch(label(d.to))} ${fmt(d.gbps)}`)
        .join(' · ');
      const crossing = dirs.reduce((s, d) => s + d.gbps, 0);
      const share =
        totalVm > 0 ? ` · ${Math.round((100 * crossing) / totalVm)}% of storage IO` : '';
      text = `ISL ${fmt(cap)} Gb: ${each}${share}${tail}`;
    } else {
      // Name the directions from the device end (NIC or array port): out = it sends.
      const sends = dirs.find((d) => kind(d.from) !== 'switch');
      const gets = dirs.find((d) => kind(d.to) !== 'switch');
      text = `out ${fmt(sends?.gbps ?? 0)} · in ${fmt(gets?.gbps ?? 0)} Gb${tail}`;
    }
    out.set(linkId, { text, tone, util });
  }
  return out;
}
