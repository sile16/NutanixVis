/**
 * Activity window (pure). Multipath IO rotates across paths tick by tick, so anything derived from a
 * single tick's traces flickers. The diagram instead reads a rolling window of the last N ticks:
 * traces are concatenated, link utilization is summed, and each link remembers how recently it
 * carried traffic so the glow can fade instead of blinking.
 */
import type { LinkView, Snapshot, Trace, TrafficCategory } from '../../engine/types';

export interface LinkActivity {
  /** Ticks since this link last carried a delivered or dropped trace (0 = this tick). */
  readonly age: number;
  /** Most frequent category on this link within the window. */
  readonly category: TrafficCategory;
  /** Traces that crossed (or died on) this link within the window. */
  readonly count: number;
  /** The most recent trace on this link was dropped there. */
  readonly dropped: boolean;
}

export interface ActivityWindow {
  /** Snapshot-shaped view: current state, but traces and link `util` cover the whole window. */
  readonly snapshot: Snapshot;
  readonly ticks: number;
  readonly links: ReadonlyMap<string, LinkActivity>;
  /** Union over the window of each VM's `ioPaths` / `ioUplinks` view fields (JSON arrays). */
  readonly vmPaths: ReadonlyMap<
    string,
    { paths: ReadonlySet<string>; uplinks: ReadonlySet<string> }
  >;
}

const jsonList = (v: unknown): string[] => {
  if (typeof v !== 'string' || v === '') return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** `history` is oldest first; the last element is the current snapshot. */
export function buildActivityWindow(history: readonly Snapshot[]): ActivityWindow {
  const current = history[history.length - 1];
  if (!current) throw new Error('activity window needs at least one snapshot');
  const traces: Trace[] = [];
  const util = new Map<string, Record<TrafficCategory, number>>();
  const perLink = new Map<
    string,
    { age: number; counts: Map<TrafficCategory, number>; count: number; dropped: boolean }
  >();
  const vmPaths = new Map<string, { paths: Set<string>; uplinks: Set<string> }>();

  history.forEach((s, i) => {
    const age = history.length - 1 - i;
    traces.push(...s.traces);
    for (const [id, l] of Object.entries(s.links)) {
      const u = util.get(id) ?? {};
      for (const [cat, n] of Object.entries(l.util)) u[cat] = (u[cat] ?? 0) + n;
      util.set(id, u);
    }
    for (const t of s.traces) {
      t.links.forEach((id, k) => {
        const e = perLink.get(id) ?? { age, counts: new Map(), count: 0, dropped: false };
        e.age = Math.min(e.age, age);
        e.count += 1;
        e.counts.set(t.category, (e.counts.get(t.category) ?? 0) + 1);
        if (age === e.age) e.dropped = t.result === 'dropped' && k === t.links.length - 1;
        perLink.set(id, e);
      });
    }
    for (const d of Object.values(s.devices)) {
      if (d.kind !== 'vm') continue;
      const v = vmPaths.get(d.id) ?? { paths: new Set<string>(), uplinks: new Set<string>() };
      for (const p of jsonList(d.fields.ioPaths)) v.paths.add(p);
      for (const u of jsonList(d.fields.ioUplinks)) v.uplinks.add(u);
      vmPaths.set(d.id, v);
    }
  });

  const links: Record<string, LinkView> = {};
  for (const [id, l] of Object.entries(current.links))
    links[id] = { ...l, util: util.get(id) ?? {} };

  const activity = new Map<string, LinkActivity>();
  for (const [id, e] of perLink) {
    let category: TrafficCategory = '';
    let best = -1;
    for (const [cat, n] of e.counts) if (n > best) [category, best] = [cat, n];
    activity.set(id, { age: e.age, category, count: e.count, dropped: e.dropped });
  }

  return {
    snapshot: { ...current, traces, links },
    ticks: history.length,
    links: activity,
    vmPaths,
  };
}

/** Glow opacity for a link: strongest this tick, fading linearly to a floor at the window edge. */
export function glowOpacity(age: number, ticks: number): number {
  if (ticks <= 1) return 0.35;
  return 0.35 - (0.25 * Math.min(age, ticks - 1)) / (ticks - 1);
}
