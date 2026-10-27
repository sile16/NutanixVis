import { describe, expect, it } from 'vitest';
import type { LinkView, Trace } from '../../engine/types';
import { type Anchor, linkGeometry } from './geometry';
import {
  deadChecker,
  dropKey,
  orientLinks,
  persistentDrops,
  roundCount,
  spritesAt,
  steadyDropPoints,
  tracePath,
} from './replay';

const link = (id: string, a: string, b: string): LinkView => ({
  id,
  a: { device: a, port: 'p0' },
  b: { device: b, port: 'p1' },
  status: 'up',
  mtu: 9000,
  latencyMs: 0,
  util: {},
});

// nic (0,0) ─l1─ switch (0,100)…(100,100) ─l2─ fa (100,200); l1 runs nic→sw, l2 runs fa→sw.
const links = {
  l1: link('l1', 'nic', 'sw'),
  l2: link('l2', 'fa', 'sw'),
};
const A = (x: number, y: number, side: Anchor['side']): Anchor => ({ x, y, side });
const geometry = new Map([
  ['l1', linkGeometry(A(0, 0, 'bottom'), A(0, 100, 'top'))],
  ['l2', linkGeometry(A(100, 200, 'top'), A(100, 120, 'bottom'))],
]);
const ctx = {
  links,
  geometry,
  devicePoint: (id: string) => (id === 'fa' ? { x: 9, y: 9 } : undefined),
};

const trace = (over: Partial<Trace>): Trace => ({
  msgId: 'm',
  kind: 'nvme-io',
  category: 'io-read',
  round: 0,
  links: ['l1', 'l2'],
  result: 'delivered',
  ...over,
});

describe('orientLinks', () => {
  it('walks each link from the device shared with the previous one', () => {
    expect(orientLinks(trace({}), links)).toEqual([true, false]);
    expect(orientLinks(trace({ links: ['l2', 'l1'] }), links)).toEqual([true, false]);
  });

  it('uses dropAt to orient a single-link trace', () => {
    expect(orientLinks(trace({ links: ['l1'], dropAt: 'sw' }), links)).toEqual([true]);
    expect(orientLinks(trace({ links: ['l1'], dropAt: 'nic' }), links)).toEqual([false]);
  });
});

describe('tracePath', () => {
  it('starts at the source, crosses the switch, ends at the destination', () => {
    const p = tracePath(trace({}), ctx);
    expect(p?.at(0)).toEqual({ x: 0, y: 0 });
    expect(p?.at(1)).toEqual({ x: 100, y: 200 });
    expect(p?.dropU).toBeNull();
    // 100 (l1) + transit (0,100)→(100,120) + 80 (l2)
    expect(p?.length).toBeCloseTo(100 + Math.hypot(100, 20) + 80, 5);
  });

  it('drops half-way along the drop link', () => {
    const p = tracePath(
      trace({ links: ['l1'], result: 'dropped', dropAt: 'l1', reason: 'link-down' }),
      ctx,
    );
    expect(p?.dropU).toBeCloseTo(0.5, 5);
    expect(p?.at(p.dropU ?? 0)).toEqual({ x: 0, y: 50 });
  });

  it('drops at the far end when dropAt is a device', () => {
    const p = tracePath(trace({ links: ['l1'], result: 'dropped', dropAt: 'sw' }), ctx);
    expect(p?.dropU).toBe(1);
  });

  it('bursts at the device when the trace never left it', () => {
    const p = tracePath(trace({ links: [], result: 'dropped', dropAt: 'fa' }), ctx);
    expect(p?.at(0.3)).toEqual({ x: 9, y: 9 });
    expect(p?.dropU).toBe(0);
  });

  it('returns null when geometry is missing', () => {
    expect(tracePath(trace({ links: ['nope'] }), ctx)).toBeNull();
  });
});

describe('spritesAt', () => {
  const t0 = trace({ msgId: 'req', round: 0 });
  const t1 = trace({ msgId: 'rsp', round: 1, links: ['l2', 'l1'] });
  const drop = trace({ msgId: 'x', links: ['l1'], result: 'dropped', dropAt: 'l1' });

  it('schedules rounds in sequence', () => {
    const traces = [t0, t1];
    const paths = traces.map((t) => tracePath(t, ctx));
    expect(roundCount(traces)).toBe(2);
    const early = spritesAt(traces, paths, 0.1);
    expect(early).toHaveLength(1);
    expect(early[0]).toMatchObject({ kind: 'packet', category: 'io-read' });
    const late = spritesAt(traces, paths, 0.6);
    expect(late).toHaveLength(1);
    expect(spritesAt(traces, paths, 0.99)).toHaveLength(0);
  });

  it('turns a dropped packet into a burst at dropAt', () => {
    const paths = [tracePath(drop, ctx)];
    expect(spritesAt([drop], paths, 0.1)[0]?.kind).toBe('packet');
    const burst = spritesAt([drop], paths, 0.5)[0];
    expect(burst).toMatchObject({ kind: 'burst', x: 0, y: 50 });
  });
});

describe('persistent drops (no blinking at a dead host)', () => {
  const toDead = trace({
    msgId: 'a',
    links: ['l1'],
    result: 'dropped',
    dropAt: 'l1',
    reason: 'link-down',
  });
  const fresh = trace({
    msgId: 'b',
    links: ['l1'],
    result: 'dropped',
    dropAt: 'sw',
    reason: 'no-route',
  });
  const ok = trace({ msgId: 'c' });
  const devices = {
    sw: {
      id: 'sw',
      kind: 'switch',
      label: 'sw',
      status: 'healthy' as const,
      badges: [],
      fields: {},
    },
  };

  it('treats drops on a down link or failed device as persistent, new drop sites as news', () => {
    const isDead = deadChecker(devices, { ...links, l1: { ...links.l1, status: 'down' } });
    expect(persistentDrops([toDead, fresh, ok], { previous: new Set(), isDead })).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('treats a drop site that also dropped last tick as persistent', () => {
    const isDead = deadChecker(devices, links);
    expect(persistentDrops([fresh], { previous: new Set([dropKey(fresh)]), isDead })).toEqual([
      true,
    ]);
    // Same site, different reason: a state change, so it bursts again.
    const other = trace({ ...fresh, reason: 'vlan-not-carried' });
    expect(persistentDrops([other], { previous: new Set([dropKey(fresh)]), isDead })).toEqual([
      false,
    ]);
  });

  it('draws no burst for a persistent drop, only a steady marker', () => {
    const paths = [tracePath(toDead, ctx)];
    expect(spritesAt([toDead], paths, 0.1, [true])[0]?.kind).toBe('packet');
    expect(spritesAt([toDead], paths, 0.5, [true])).toHaveLength(0);
    expect(spritesAt([toDead], paths, 0.5, [false])[0]?.kind).toBe('burst');
    expect(steadyDropPoints([...paths, ...paths], [true, true])).toEqual([{ x: 0, y: 50 }]);
    expect(steadyDropPoints(paths, [false])).toEqual([]);
  });
});
