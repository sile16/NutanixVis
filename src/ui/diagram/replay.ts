/**
 * Trace replay (pure): where each packet of a tick is at a given phase of the tick's real-time
 * window. The canvas overlay calls `spritesAt` every animation frame; nothing here touches the
 * DOM or React Flow, so it is unit-tested headless. Animation is cosmetic (SPEC §8): it only
 * replays `Snapshot.traces` and never feeds back into the engine.
 *
 * Scheduling: delivery round r of R occupies [r/R, (r+1)/R] of the window. Within its round a
 * packet travels its links in order at constant speed over the first `TRAVEL` share of the round
 * window. A dropped packet stops at `dropAt` (half-way along a link, or at a device) and bursts.
 */
import type { DeviceView, LinkView, Trace } from '../../engine/types';
import type { LinkGeometry, Point } from './geometry';
import { distance, polylineSampler } from './geometry';

const TRAVEL = 0.8;
const BURST = 0.45;

export interface ReplayContext {
  readonly links: Readonly<Record<string, LinkView>>;
  readonly geometry: ReadonlyMap<string, LinkGeometry>;
  /** Centre of a device on the diagram (used for drops that happen before any link). */
  readonly devicePoint: (id: string) => Point | undefined;
}

export interface TracePath {
  readonly length: number;
  at(u: number): Point;
  /** Fraction of the path at which the packet is dropped (null if delivered). */
  readonly dropU: number | null;
}

export type Sprite =
  | { readonly kind: 'packet'; readonly x: number; readonly y: number; readonly category: string }
  | { readonly kind: 'burst'; readonly x: number; readonly y: number; readonly progress: number };

const shared = (p: LinkView, q: LinkView): string | undefined => {
  const pe = [p.a.device, p.b.device];
  return [q.a.device, q.b.device].find((d) => pe.includes(d));
};

/** For each link of a trace, whether the packet travels it a → b. */
export function orientLinks(trace: Trace, links: Readonly<Record<string, LinkView>>): boolean[] {
  const ls = trace.links.map((id) => links[id]);
  return ls.map((l, i) => {
    if (!l) return true;
    const next = ls[i + 1];
    const prev = ls[i - 1];
    if (next) {
      const s = shared(l, next);
      return s === undefined ? true : l.b.device === s;
    }
    if (prev) {
      const s = shared(prev, l);
      return s === undefined ? true : l.a.device === s;
    }
    return trace.dropAt !== l.a.device;
  });
}

interface Piece {
  readonly length: number;
  at(s: number): Point;
}

export function tracePath(trace: Trace, ctx: ReplayContext): TracePath | null {
  if (trace.links.length === 0) {
    const p = trace.dropAt ? ctx.devicePoint(trace.dropAt) : undefined;
    if (!p) return null;
    return { length: 0, at: () => p, dropU: trace.result === 'dropped' ? 0 : null };
  }
  const forward = orientLinks(trace, ctx.links);
  const pieces: Piece[] = [];
  let prevEnd: Point | null = null;
  let lastLinkLength = 0;
  for (const [i, id] of trace.links.entries()) {
    const g = ctx.geometry.get(id);
    if (!g) return null;
    const fwd = forward[i] ?? true;
    const at = fwd ? g.pointAt : (s: number) => g.pointAt(1 - s);
    const start = at(0);
    if (prevEnd && distance(prevEnd, start) > 0.5) {
      // Transit through the device between two cables (e.g. across a switch).
      const transit = polylineSampler([prevEnd, start]);
      pieces.push({ length: transit.length, at: transit.pointAt });
    }
    pieces.push({ length: g.length, at });
    prevEnd = at(1);
    lastLinkLength = g.length;
  }
  const length = pieces.reduce((s, p) => s + p.length, 0);
  const at = (u: number): Point => {
    let d = Math.min(Math.max(u, 0), 1) * length;
    for (const p of pieces) {
      if (d <= p.length || p === pieces[pieces.length - 1]) {
        return p.at(p.length > 0 ? Math.min(d / p.length, 1) : 1);
      }
      d -= p.length;
    }
    return prevEnd ?? { x: 0, y: 0 };
  };
  let dropU: number | null = null;
  if (trace.result === 'dropped') {
    const lastId = trace.links[trace.links.length - 1];
    dropU = trace.dropAt === lastId && length > 0 ? (length - lastLinkLength / 2) / length : 1;
  }
  return { length, at, dropU };
}

export function roundCount(traces: readonly Trace[]): number {
  return traces.reduce((m, t) => Math.max(m, t.round + 1), 1);
}

/** Identity of a drop site: where and why. Repeats of the same key are "the same drop". */
export const dropKey = (t: Trace): string => `${t.dropAt ?? ''}|${t.reason ?? ''}`;

export interface DropContext {
  /** Drop keys seen in the previous tick (see `dropKey`). */
  readonly previous: ReadonlySet<string>;
  /** True if `id` (a link or device) is down: link `down`, device `failed`/`offline`. */
  readonly isDead: (id: string) => boolean;
}

/** `DropContext.isDead` over a snapshot's devices and links. */
export function deadChecker(
  devices: Readonly<Record<string, DeviceView>>,
  links: Readonly<Record<string, LinkView>>,
): (id: string) => boolean {
  return (id) => {
    const l = links[id];
    if (l) return l.status === 'down';
    const d = devices[id];
    if (!d) return false;
    return d.status === 'failed' || d.status === 'offline' || d.fields.down === true;
  };
}

/**
 * Which dropped traces are persistent rather than news. Peers keep sending to a dead host every
 * tick (HA polls, ZK, replication) and every one is dropped at the same port: replaying a red
 * burst there each tick reads as blinking. A drop is persistent if it lands on something that is
 * down, or if the same (site, reason) already dropped last tick; only the others burst.
 */
export function persistentDrops(traces: readonly Trace[], ctx: DropContext): boolean[] {
  return traces.map(
    (t) =>
      t.result === 'dropped' &&
      ((t.dropAt !== undefined && ctx.isDead(t.dropAt)) || ctx.previous.has(dropKey(t))),
  );
}

/** Drop sites of persistent drops (deduplicated), drawn as a steady marker instead of a burst. */
export function steadyDropPoints(
  paths: readonly (TracePath | null)[],
  steady: readonly boolean[],
): Point[] {
  const out = new Map<string, Point>();
  paths.forEach((p, i) => {
    if (!p || !steady[i] || p.dropU === null) return;
    const at = p.at(p.dropU);
    out.set(`${Math.round(at.x)},${Math.round(at.y)}`, at);
  });
  return [...out.values()];
}

/**
 * Sprites to draw at `phase` ∈ [0, 1] of the tick window. `paths[i]` is `tracePath(traces[i])`.
 * `steady[i]` marks a persistent drop: the packet still travels to the drop site, then vanishes
 * without a burst (the overlay draws a steady marker there instead).
 */
export function spritesAt(
  traces: readonly Trace[],
  paths: readonly (TracePath | null)[],
  phase: number,
  steady: readonly boolean[] = [],
): Sprite[] {
  const rounds = roundCount(traces);
  const out: Sprite[] = [];
  traces.forEach((t, i) => {
    const path = paths[i];
    if (!path) return;
    const w0 = t.round / rounds;
    const span = 1 / rounds;
    const local = (phase - w0) / span; // 0..1 within the round window
    if (local < 0 || local > 1) return;
    const travel = local / TRAVEL;
    if (path.dropU === null) {
      if (travel > 1) return;
      const p = path.at(travel);
      out.push({ kind: 'packet', x: p.x, y: p.y, category: t.category });
      return;
    }
    // Dropped: travel to dropU (scaled into the travel share), then burst.
    const stopAt = path.dropU;
    if (travel < stopAt) {
      const p = path.at(travel);
      out.push({ kind: 'packet', x: p.x, y: p.y, category: t.category });
      return;
    }
    if (steady[i]) return;
    const progress = (travel - stopAt) / BURST;
    if (progress > 1) return;
    const p = path.at(stopAt);
    out.push({ kind: 'burst', x: p.x, y: p.y, progress });
  });
  return out;
}
