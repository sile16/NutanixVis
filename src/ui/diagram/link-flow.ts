/**
 * Continuous link flow (pure). Replaying each tick's traces end to end in one tick window made dots
 * race across the diagram, and they stopped dead while paused. Instead (as in ActiveClusterVis),
 * every cable that carried traffic in the activity window shows a steady stream of slow dots, one
 * stream per (category, direction). Dots move at a fixed on-screen speed on wall-clock time, so they
 * keep moving at the same pace whether the simulation is paused, stepping, or running at ×60.
 *
 * A stream fades as its traffic ages out of the window. A cable whose last trace was dropped on it
 * streams only up to the drop point (the overlay marks the drop there).
 */
import type { LinkView, Snapshot, TrafficCategory } from '../../engine/types';
import type { LinkGeometry, Point } from './geometry';
import { orientLinks } from './replay';

/** World units (diagram px at zoom 1) per second. ActiveClusterVis: one cable per ~2 s. */
export const FLOW_SPEED = 60;
/** Gap between consecutive dots of one stream on a long cable. */
export const FLOW_SPACING = 150;
const MIN_SPACING = 40;

export interface LinkFlow {
  readonly linkId: string;
  readonly category: TrafficCategory;
  /** Travels a → b. */
  readonly forward: boolean;
  /** Fraction of the cable the stream reaches (1, or the drop point for dropped traffic). */
  readonly end: number;
  /** Ticks since this stream last carried a trace (0 = this tick). */
  readonly age: number;
  /** Traces in the window. */
  readonly count: number;
}

export interface FlowDot extends Point {
  readonly category: TrafficCategory;
  readonly alpha: number;
}

/**
 * Streams over `history` (oldest first; the last element is the current snapshot). Only categories
 * passing `visible` count, and no stream is drawn on a cable that is down now.
 */
export function linkFlows(
  history: readonly Pick<Snapshot, 'traces' | 'links'>[],
  visible: (category: TrafficCategory) => boolean = () => true,
): LinkFlow[] {
  const current = history[history.length - 1];
  if (!current) return [];
  const flows = new Map<string, { -readonly [K in keyof LinkFlow]: LinkFlow[K] }>();
  history.forEach((s, i) => {
    const age = history.length - 1 - i;
    const links: Readonly<Record<string, LinkView>> = s.links;
    for (const t of s.traces) {
      if (!visible(t.category) || t.links.length === 0) continue;
      const forward = orientLinks(t, links);
      t.links.forEach((linkId, k) => {
        if (current.links[linkId]?.status === 'down') return;
        const fwd = forward[k] ?? true;
        const droppedHere =
          t.result === 'dropped' && k === t.links.length - 1 && t.dropAt === linkId;
        const key = `${linkId}|${t.category}|${fwd ? '>' : '<'}`;
        const f = flows.get(key) ?? {
          linkId,
          category: t.category,
          forward: fwd,
          end: 0,
          age,
          count: 0,
        };
        f.age = Math.min(f.age, age);
        f.count += 1;
        f.end = Math.max(f.end, droppedHere ? 0.5 : 1);
        flows.set(key, f);
      });
    }
  });
  return [...flows.values()].sort((a, b) =>
    a.linkId === b.linkId ? a.category.localeCompare(b.category) : a.linkId < b.linkId ? -1 : 1,
  );
}

/** Stream opacity: full for recent traffic, fading toward the edge of the window. */
export function flowAlpha(age: number, ticks: number): number {
  if (age <= 1 || ticks <= 2) return 1;
  return Math.max(0.25, 1 - (0.75 * (age - 1)) / (ticks - 2));
}

/** Dot positions at wall-clock time `ms` for every stream. */
export function flowDotsAt(
  flows: readonly LinkFlow[],
  geometry: ReadonlyMap<string, LinkGeometry>,
  ms: number,
  ticks: number,
): FlowDot[] {
  const out: FlowDot[] = [];
  // Streams sharing a cable are staggered so their dots don't sit on top of each other.
  const perLink = new Map<string, number>();
  for (const f of flows) perLink.set(f.linkId, (perLink.get(f.linkId) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const f of flows) {
    const g = geometry.get(f.linkId);
    if (!g || g.length <= 0) continue;
    const n = perLink.get(f.linkId) ?? 1;
    const idx = seen.get(f.linkId) ?? 0;
    seen.set(f.linkId, idx + 1);
    const reach = g.length * f.end;
    const spacing = Math.min(FLOW_SPACING, Math.max(MIN_SPACING, reach));
    const head = ((ms / 1000) * FLOW_SPEED + (idx * spacing) / n) % spacing;
    const alpha = flowAlpha(f.age, ticks);
    for (let s = head; s <= reach; s += spacing) {
      const u = s / g.length;
      const p = g.pointAt(f.forward ? u : 1 - u);
      out.push({ x: p.x, y: p.y, category: f.category, alpha });
    }
  }
  return out;
}
