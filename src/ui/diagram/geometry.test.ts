import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type Anchor,
  assignLanes,
  computeLinkGeometries,
  distance,
  flatten,
  laneOffset,
  linkGeometry,
  polylineSampler,
  roundedPath,
  routeOrthogonal,
  type Side,
  simplify,
} from './geometry';

const A = (x: number, y: number, side: Side): Anchor => ({ x, y, side });

const isOrthogonal = (pts: readonly { x: number; y: number }[]) =>
  pts.every((p, i) => {
    const q = pts[i + 1];
    return !q || Math.abs(p.x - q.x) < 1e-6 || Math.abs(p.y - q.y) < 1e-6;
  });

describe('routeOrthogonal', () => {
  it('routes a straight vertical cable with no bends', () => {
    const pts = routeOrthogonal(A(100, 0, 'bottom'), A(100, 200, 'top'));
    expect(pts).toEqual([
      { x: 100, y: 0 },
      { x: 100, y: 200 },
    ]);
  });

  it('routes bottom→top with a Z bend half-way between the stubs', () => {
    const pts = routeOrthogonal(A(0, 0, 'bottom'), A(100, 200, 'top'), { stub: 20 });
    expect(pts).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
      { x: 100, y: 200 },
    ]);
  });

  it('routes right→left (ISL) with a vertical middle segment', () => {
    const pts = routeOrthogonal(A(0, 0, 'right'), A(200, 40, 'left'), { stub: 10 });
    expect(pts).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 40 },
      { x: 200, y: 40 },
    ]);
  });

  it('routes mixed sides with a single bend', () => {
    const pts = routeOrthogonal(A(0, 0, 'bottom'), A(100, 100, 'left'), { stub: 10 });
    expect(pts).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ]);
  });

  it('offsets the middle segment by lane and keeps it between the stubs', () => {
    const base = { stub: 10, laneCount: 3, laneSpacing: 10 };
    const y = (lane: number) =>
      routeOrthogonal(A(0, 0, 'bottom'), A(100, 100, 'top'), { ...base, lane })[1]?.y;
    expect([y(0), y(1), y(2)]).toEqual([40, 50, 60]);
    const clamped = routeOrthogonal(A(0, 0, 'bottom'), A(100, 100, 'top'), {
      stub: 10,
      lane: 0,
      laneCount: 2,
      laneSpacing: 500,
    });
    expect(clamped[1]?.y).toBe(10);
  });

  it('always produces orthogonal routes that start and end on the anchors', () => {
    const side = fc.constantFrom<Side>('top', 'right', 'bottom', 'left');
    const coord = fc.integer({ min: -500, max: 500 });
    fc.assert(
      fc.property(coord, coord, side, coord, coord, side, (ax, ay, as, bx, by, bs) => {
        const pts = routeOrthogonal(A(ax, ay, as), A(bx, by, bs));
        expect(pts[0]).toEqual({ x: ax, y: ay });
        expect(pts[pts.length - 1]).toEqual({ x: bx, y: by });
        expect(isOrthogonal(pts)).toBe(true);
      }),
    );
  });
});

describe('simplify', () => {
  it('removes duplicates and collinear points', () => {
    expect(
      simplify([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 5 },
        { x: 0, y: 10 },
        { x: 5, y: 10 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 5, y: 10 },
    ]);
  });
});

describe('roundedPath', () => {
  it('emits M/L for a straight line', () => {
    expect(
      roundedPath([
        { x: 0, y: 0 },
        { x: 0, y: 10 },
      ]),
    ).toBe('M 0 0 L 0 10');
  });

  it('rounds each corner with a quadratic curve, clamped to half the shorter segment', () => {
    const d = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 0, y: 6 },
        { x: 100, y: 6 },
      ],
      8,
    );
    expect(d).toBe('M 0 0 L 0 3 Q 0 6 3 6 L 100 6');
  });

  it('returns an empty path for no points', () => {
    expect(roundedPath([])).toBe('');
  });
});

describe('pointAt', () => {
  it('walks a straight segment linearly', () => {
    const s = polylineSampler([
      { x: 0, y: 0 },
      { x: 0, y: 100 },
    ]);
    expect(s.length).toBe(100);
    expect(s.pointAt(0)).toEqual({ x: 0, y: 0 });
    expect(s.pointAt(0.25)).toEqual({ x: 0, y: 25 });
    expect(s.pointAt(1)).toEqual({ x: 0, y: 100 });
    expect(s.pointAt(2)).toEqual({ x: 0, y: 100 });
    expect(s.pointAt(-1)).toEqual({ x: 0, y: 0 });
  });

  it('follows the rounded path: endpoints match, length is shorter than the sharp route', () => {
    const g = linkGeometry(A(0, 0, 'bottom'), A(100, 200, 'top'), { stub: 20, radius: 8 });
    expect(g.pointAt(0)).toEqual({ x: 0, y: 0 });
    expect(g.pointAt(1)).toEqual({ x: 100, y: 200 });
    const sharp = 100 + 100 + 100;
    expect(g.length).toBeLessThan(sharp);
    expect(g.length).toBeGreaterThan(sharp - 2 * 8 * (2 - Math.SQRT2));
    // Midpoint of a symmetric Z is its centre.
    const mid = g.pointAt(0.5);
    expect(mid.x).toBeCloseTo(50, 5);
    expect(mid.y).toBeCloseTo(100, 5);
  });

  it('never jumps further than the arc length between two fractions (property)', () => {
    const g = linkGeometry(A(10, 0, 'bottom'), A(300, 250, 'top'), { radius: 10 });
    const t = fc.double({ min: 0, max: 1, noNaN: true });
    fc.assert(
      fc.property(t, t, (t1, t2) => {
        const [lo, hi] = t1 <= t2 ? [t1, t2] : [t2, t1];
        expect(distance(g.pointAt(lo), g.pointAt(hi))).toBeLessThanOrEqual(
          (hi - lo) * g.length + 1e-6,
        );
      }),
    );
  });

  it('flattened corners stay within the corner radius of the sharp route', () => {
    const pts = routeOrthogonal(A(0, 0, 'bottom'), A(100, 200, 'top'), { stub: 20 });
    for (const p of flatten(pts, 8)) {
      const nearSharp = pts.some((c, i) => {
        const d = pts[i + 1];
        if (!d) return false;
        const onX = Math.abs(c.x - d.x) < 1e-6 && Math.abs(p.x - c.x) < 1e-6;
        const onY = Math.abs(c.y - d.y) < 1e-6 && Math.abs(p.y - c.y) < 1e-6;
        return onX || onY || distance(p, c) <= 8;
      });
      expect(nearSharp).toBe(true);
    }
  });
});

describe('lanes', () => {
  it('is centred on zero', () => {
    expect(laneOffset(0, 1)).toBe(0);
    expect([0, 1, 2].map((l) => laneOffset(l, 3, 4))).toEqual([-4, 0, 4]);
  });

  it('gives parallel links in the same channel distinct middle segments', () => {
    const links = [0, 1, 2, 3].map((i) => ({
      id: `l${i}`,
      a: A(i * 20, 0, 'bottom'),
      b: A(200 + i * 20, 120, 'top'),
    }));
    const lanes = assignLanes(links);
    expect(new Set([...lanes.values()].map((l) => l.lane)).size).toBe(4);
    const geoms = computeLinkGeometries(links);
    const mids = links.map((l) => geoms.get(l.id)?.points[1]?.y);
    expect(new Set(mids).size).toBe(4);
    // Rightward links starting further right take the upper lanes (no crossings).
    const byStart = [...links].sort((p, q) => q.a.x - p.a.x).map((l) => lanes.get(l.id)?.lane);
    expect(byStart).toEqual([0, 1, 2, 3]);
  });

  it('does not assign lanes to straight links or across different channels', () => {
    const lanes = assignLanes([
      { id: 'straight', a: A(0, 0, 'bottom'), b: A(0, 100, 'top') },
      { id: 'upper', a: A(0, 0, 'bottom'), b: A(50, 100, 'top') },
      { id: 'lower', a: A(0, 300, 'bottom'), b: A(50, 400, 'top') },
    ]);
    expect(lanes.has('straight')).toBe(false);
    expect(lanes.get('upper')?.laneCount).toBe(1);
    expect(lanes.get('lower')?.laneCount).toBe(1);
  });

  it('shrinks spacing to fit narrow channels', () => {
    const links = Array.from({ length: 10 }, (_, i) => ({
      id: `l${i}`,
      a: A(i * 10, 0, 'bottom'),
      b: A(500, 72, 'top'),
    }));
    const lanes = assignLanes(links, { stub: 16, maxSpacing: 8 });
    const spacing = lanes.get('l0')?.laneSpacing ?? 0;
    expect(spacing * 9).toBeLessThanOrEqual(40);
  });
});
