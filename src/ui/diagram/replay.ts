/**
 * Trace geometry (pure): the diagram path a trace takes, which way it crosses each cable, and where
 * it was dropped (half-way along a link, or at a device). The overlay uses it for drop bursts and
 * steady drop markers, and `link-flow.ts` for stream direction. Nothing here touches the DOM or
 * React Flow, so it is unit-tested headless. Animation is cosmetic (SPEC §8): it only reads
 * `Snapshot.traces` and never feeds back into the engine.
 */
import type { DeviceView, LinkView, Trace } from '../../engine/types';
import type { LinkGeometry, Point } from './geometry';
import { distance, polylineSampler } from './geometry';

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
