/**
 * Edge geometry (SPEC §3): a pure module that turns two port anchors into an orthogonal route
 * with rounded corners. The same geometry feeds the SVG edge (`pathD`) and the packet overlay
 * (`pointAt`), so nothing reads React Flow internals. Parallel links are offset into lanes.
 * No DOM, no React: unit-tested in `geometry.test.ts`.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type Side = 'top' | 'right' | 'bottom' | 'left';

/** A port location on a device border, plus the direction the cable leaves in. */
export interface Anchor extends Point {
  readonly side: Side;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface RouteOptions {
  /** Straight run out of the port before the first bend. */
  readonly stub?: number;
  /** Corner radius. */
  readonly radius?: number;
  /** Lane index of this link among `laneCount` links sharing the same channel. */
  readonly lane?: number;
  readonly laneCount?: number;
  /** Distance between adjacent lanes. */
  readonly laneSpacing?: number;
}

export interface LinkGeometry {
  /** Corner points of the orthogonal route (before rounding). */
  readonly points: readonly Point[];
  /** SVG path data with rounded corners. */
  readonly pathD: string;
  /** Length of the rounded path. */
  readonly length: number;
  /** Point at fraction `t` ∈ [0, 1] of the rounded path, from source to target. */
  pointAt(t: number): Point;
}

const DIR: Readonly<Record<Side, Point>> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

const EPS = 1e-6;

export const isVertical = (side: Side): boolean => side === 'top' || side === 'bottom';

const add = (p: Point, q: Point): Point => ({ x: p.x + q.x, y: p.y + q.y });
const scale = (p: Point, k: number): Point => ({ x: p.x * k, y: p.y * k });
const sub = (p: Point, q: Point): Point => ({ x: p.x - q.x, y: p.y - q.y });
export const distance = (p: Point, q: Point): number => Math.hypot(p.x - q.x, p.y - q.y);

/** The offset of lane `lane` of `count`, centred on 0. */
export function laneOffset(lane = 0, count = 1, spacing = 8): number {
  if (count <= 1) return 0;
  return (lane - (count - 1) / 2) * spacing;
}

/** Drop repeated points and middle points that are collinear with their neighbours. */
export function simplify(points: readonly Point[]): Point[] {
  const dedup: Point[] = [];
  for (const p of points) {
    const last = dedup[dedup.length - 1];
    if (!last || distance(last, p) > EPS) dedup.push(p);
  }
  const out: Point[] = [];
  for (const p of dedup) {
    while (out.length >= 2) {
      const a = out[out.length - 2] as Point;
      const b = out[out.length - 1] as Point;
      const cross = (b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x);
      if (Math.abs(cross) > EPS) break;
      out.pop();
    }
    out.push(p);
  }
  return out;
}

/**
 * Orthogonal route from `a` to `b`. Each end leaves its port along its side for `stub`, then the
 * route bends through a middle segment placed half-way between the stubs, shifted by the lane
 * offset so parallel cables don't overlap.
 */
export function routeOrthogonal(a: Anchor, b: Anchor, opts: RouteOptions = {}): Point[] {
  const stub = opts.stub ?? 16;
  const off = laneOffset(opts.lane, opts.laneCount, opts.laneSpacing);
  const a1 = add(a, scale(DIR[a.side], stub));
  const b1 = add(b, scale(DIR[b.side], stub));
  const aV = isVertical(a.side);
  const bV = isVertical(b.side);
  let mid: Point[];
  if (aV && bV) {
    const lo = Math.min(a1.y, b1.y);
    const hi = Math.max(a1.y, b1.y);
    const my = clamp((a1.y + b1.y) / 2 + off, lo, hi);
    mid = [
      { x: a1.x, y: my },
      { x: b1.x, y: my },
    ];
  } else if (!aV && !bV) {
    const lo = Math.min(a1.x, b1.x);
    const hi = Math.max(a1.x, b1.x);
    const mx = clamp((a1.x + b1.x) / 2 + off, lo, hi);
    mid = [
      { x: mx, y: a1.y },
      { x: mx, y: b1.y },
    ];
  } else if (aV) {
    mid = [{ x: a1.x, y: b1.y }];
  } else {
    mid = [{ x: b1.x, y: a1.y }];
  }
  return simplify([{ x: a.x, y: a.y }, a1, ...mid, b1, { x: b.x, y: b.y }]);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

const fmt = (n: number): string => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

interface Corner {
  readonly from: Point;
  readonly ctrl: Point;
  readonly to: Point;
}

/** Corner geometry for each interior point: a quadratic curve replacing the sharp bend. */
function corners(points: readonly Point[], radius: number): Corner[] {
  const out: Corner[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1] as Point;
    const cur = points[i] as Point;
    const next = points[i + 1] as Point;
    const lIn = distance(prev, cur);
    const lOut = distance(cur, next);
    const r = Math.min(radius, lIn / 2, lOut / 2);
    const dIn = lIn > EPS ? scale(sub(cur, prev), 1 / lIn) : { x: 0, y: 0 };
    const dOut = lOut > EPS ? scale(sub(next, cur), 1 / lOut) : { x: 0, y: 0 };
    out.push({ from: sub(cur, scale(dIn, r)), ctrl: cur, to: add(cur, scale(dOut, r)) });
  }
  return out;
}

/** SVG path data for a polyline with rounded corners (quadratic curves at each bend). */
export function roundedPath(points: readonly Point[], radius = 8): string {
  const first = points[0];
  if (!first) return '';
  const cs = corners(points, radius);
  const parts = [`M ${fmt(first.x)} ${fmt(first.y)}`];
  for (const c of cs) {
    parts.push(`L ${fmt(c.from.x)} ${fmt(c.from.y)}`);
    parts.push(`Q ${fmt(c.ctrl.x)} ${fmt(c.ctrl.y)} ${fmt(c.to.x)} ${fmt(c.to.y)}`);
  }
  const last = points[points.length - 1] as Point;
  if (points.length > 1) parts.push(`L ${fmt(last.x)} ${fmt(last.y)}`);
  return parts.join(' ');
}

const quad = (c: Corner, t: number): Point => {
  const u = 1 - t;
  return {
    x: u * u * c.from.x + 2 * u * t * c.ctrl.x + t * t * c.to.x,
    y: u * u * c.from.y + 2 * u * t * c.ctrl.y + t * t * c.to.y,
  };
};

/** The rounded path flattened to a dense polyline (corners sampled), for length and pointAt. */
export function flatten(points: readonly Point[], radius = 8, samplesPerCorner = 6): Point[] {
  const first = points[0];
  if (!first) return [];
  const out: Point[] = [first];
  for (const c of corners(points, radius)) {
    out.push(c.from);
    for (let s = 1; s <= samplesPerCorner; s++) out.push(quad(c, s / samplesPerCorner));
  }
  if (points.length > 1) out.push(points[points.length - 1] as Point);
  return simplify(out);
}

/** Cumulative-length sampler over a polyline. */
export function polylineSampler(poly: readonly Point[]): {
  readonly length: number;
  pointAt(t: number): Point;
} {
  const cum: number[] = [0];
  for (let i = 1; i < poly.length; i++) {
    cum.push((cum[i - 1] as number) + distance(poly[i - 1] as Point, poly[i] as Point));
  }
  const length = cum[cum.length - 1] ?? 0;
  return {
    length,
    pointAt(t: number): Point {
      const first = poly[0];
      if (!first) return { x: 0, y: 0 };
      if (poly.length === 1 || length <= EPS) return first;
      const target = clamp(t, 0, 1) * length;
      let lo = 0;
      let hi = cum.length - 1;
      while (hi - lo > 1) {
        const midIdx = (lo + hi) >> 1;
        if ((cum[midIdx] as number) <= target) lo = midIdx;
        else hi = midIdx;
      }
      const p = poly[lo] as Point;
      const q = poly[hi] as Point;
      const segLen = (cum[hi] as number) - (cum[lo] as number);
      const k = segLen > EPS ? (target - (cum[lo] as number)) / segLen : 0;
      return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
    },
  };
}

/** Full geometry for one link. */
export function linkGeometry(a: Anchor, b: Anchor, opts: RouteOptions = {}): LinkGeometry {
  const radius = opts.radius ?? 8;
  const points = routeOrthogonal(a, b, opts);
  const sampler = polylineSampler(flatten(points, radius));
  return {
    points,
    pathD: roundedPath(points, radius),
    length: sampler.length,
    pointAt: sampler.pointAt,
  };
}

export interface LinkEnds {
  readonly id: string;
  readonly a: Anchor;
  readonly b: Anchor;
}

export interface LaneAssignment {
  readonly lane: number;
  readonly laneCount: number;
  readonly laneSpacing: number;
}

/**
 * Assign lanes to links whose middle segments would otherwise overlap. Links are grouped into a
 * channel by the band their middle segment runs in (rounded stub coordinates). Within a channel,
 * rightward links are ordered right-to-left and leftward links left-to-right, which removes
 * avoidable crossings between links travelling the same way. Spacing shrinks to fit the channel.
 */
export function assignLanes(
  links: readonly LinkEnds[],
  opts: { readonly stub?: number; readonly maxSpacing?: number; readonly band?: number } = {},
): Map<string, LaneAssignment> {
  const stub = opts.stub ?? 16;
  const maxSpacing = opts.maxSpacing ?? 8;
  const band = opts.band ?? 12;
  const groups = new Map<string, { link: LinkEnds; key: number; gap: number }[]>();
  for (const l of links) {
    const aV = isVertical(l.a.side);
    const bV = isVertical(l.b.side);
    if (aV !== bV) continue; // L-shaped routes have no middle segment to share
    const a1 = add(l.a, scale(DIR[l.a.side], stub));
    const b1 = add(l.b, scale(DIR[l.b.side], stub));
    // Normalise so `near` is the end with the smaller cross coordinate (top, or left).
    const cross = (p: Point) => (aV ? p.y : p.x);
    const alongOf = (p: Point) => (aV ? p.x : p.y);
    const [near, far] = cross(a1) <= cross(b1) ? [a1, b1] : [b1, a1];
    const along = alongOf(far) - alongOf(near);
    if (Math.abs(along) < 1) continue; // straight: no middle segment
    const lo = cross(near);
    const hi = cross(far);
    const ch = `${aV ? 'h' : 'v'}:${Math.round(lo / band)}:${Math.round(hi / band)}`;
    const start = alongOf(near);
    // Links heading towards +along take the nearest lanes when they start furthest along;
    // links heading towards −along mirror that. This removes crossings between staggered
    // same-direction links (nested spans cross once whatever the order).
    const key = along > 0 ? -start : 1e6 + start;
    const list = groups.get(ch) ?? [];
    list.push({ link: l, key, gap: hi - lo });
    groups.set(ch, list);
  }
  const out = new Map<string, LaneAssignment>();
  for (const list of groups.values()) {
    list.sort((p, q) => p.key - q.key || p.link.id.localeCompare(q.link.id));
    const gap = Math.min(...list.map((e) => e.gap));
    const laneSpacing = Math.min(
      maxSpacing,
      list.length > 1 ? (gap * 0.8) / (list.length - 1) : maxSpacing,
    );
    list.forEach((e, i) => {
      out.set(e.link.id, { lane: i, laneCount: list.length, laneSpacing });
    });
  }
  return out;
}

/** Geometry for every link, lanes included. */
export function computeLinkGeometries(
  links: readonly LinkEnds[],
  opts: Omit<RouteOptions, 'lane' | 'laneCount' | 'laneSpacing'> = {},
): Map<string, LinkGeometry> {
  const lanes = assignLanes(links, opts.stub === undefined ? {} : { stub: opts.stub });
  const out = new Map<string, LinkGeometry>();
  for (const l of links) {
    const lane = lanes.get(l.id);
    out.set(l.id, linkGeometry(l.a, l.b, { ...opts, ...lane }));
  }
  return out;
}
