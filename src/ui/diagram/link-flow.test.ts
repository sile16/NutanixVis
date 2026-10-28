import { describe, expect, it } from 'vitest';
import type { LinkView, Trace } from '../../engine/types';
import { type Anchor, linkGeometry } from './geometry';
import { FLOW_SPACING, FLOW_SPEED, flowAlpha, flowDotsAt, linkFlows } from './link-flow';

const link = (id: string, a: string, b: string, status: LinkView['status'] = 'up'): LinkView => ({
  id,
  a: { device: a, port: 'p0' },
  b: { device: b, port: 'p1' },
  status,
  mtu: 9000,
  latencyMs: 0,
  util: {},
});

// nic ─l1─ sw ─l2─ fa; l2 is cabled fa→sw, so a nic→fa trace crosses it b → a.
const links = { l1: link('l1', 'nic', 'sw'), l2: link('l2', 'fa', 'sw') };
const A = (x: number, y: number, side: Anchor['side']): Anchor => ({ x, y, side });
// l1: a straight 300-long vertical cable.
const geometry = new Map([['l1', linkGeometry(A(0, 0, 'bottom'), A(0, 300, 'top'))]]);

const trace = (over: Partial<Trace>): Trace => ({
  msgId: 'm',
  kind: 'nvme-io',
  category: 'io-read',
  round: 0,
  links: ['l1', 'l2'],
  result: 'delivered',
  ...over,
});

describe('linkFlows', () => {
  it('makes one stream per cable, category and direction', () => {
    const flows = linkFlows([
      { links, traces: [trace({}), trace({ msgId: 'n' }), trace({ links: ['l2', 'l1'] })] },
    ]);
    const l1 = flows.filter((f) => f.linkId === 'l1');
    expect(l1.map((f) => [f.forward, f.count])).toEqual(
      expect.arrayContaining([
        [true, 2],
        [false, 1],
      ]),
    );
    expect(flows.find((f) => f.linkId === 'l2' && f.count === 2)?.forward).toBe(false);
  });

  it('remembers the newest tick a stream carried traffic and skips hidden categories', () => {
    const flows = linkFlows(
      [
        { links, traces: [trace({}), trace({ category: 'zk' })] },
        { links, traces: [] },
      ],
      (c) => c !== 'zk',
    );
    expect(flows.every((f) => f.category === 'io-read' && f.age === 1)).toBe(true);
  });

  it('stops a dropped stream at the drop point and draws none on a down cable', () => {
    const dropped = trace({ links: ['l1'], result: 'dropped', dropAt: 'l1' });
    expect(linkFlows([{ links, traces: [dropped] }])[0]?.end).toBe(0.5);
    const down = { ...links, l1: link('l1', 'nic', 'sw', 'down') };
    expect(linkFlows([{ links: down, traces: [trace({})] }]).map((f) => f.linkId)).toEqual(['l2']);
  });
});

describe('flowDotsAt', () => {
  const flow = {
    linkId: 'l1',
    category: 'io-read',
    forward: true,
    end: 1,
    age: 0,
    count: 1,
  } as const;

  it('moves dots at a fixed, slow on-screen speed on wall-clock time', () => {
    const at0 = flowDotsAt([flow], geometry, 0, 10);
    const at1 = flowDotsAt([flow], geometry, 1000, 10);
    expect(at0.map((d) => d.y)).toEqual([0, FLOW_SPACING, 2 * FLOW_SPACING]);
    expect(at1[0]?.y).toBeCloseTo(FLOW_SPEED);
    // Slow: a dot needs seconds, not a fraction of a tick, to cross a 300-long cable.
    expect(300 / FLOW_SPEED).toBeGreaterThan(3);
  });

  it('runs reverse streams b → a and dropped streams only to the drop point', () => {
    const rev = flowDotsAt([{ ...flow, forward: false }], geometry, 0, 10);
    expect(rev[0]?.y).toBeCloseTo(300);
    const cut = flowDotsAt([{ ...flow, end: 0.5 }], geometry, 0, 10);
    expect(Math.max(...cut.map((d) => d.y))).toBeLessThanOrEqual(150);
  });

  it('staggers streams that share a cable and fades old ones', () => {
    const two = flowDotsAt([flow, { ...flow, category: 'io-write' }], geometry, 0, 10);
    const ys = new Set(two.map((d) => Math.round(d.y)));
    expect(ys.size).toBe(two.length);
    expect(flowAlpha(0, 10)).toBe(1);
    expect(flowAlpha(9, 10)).toBeLessThan(flowAlpha(3, 10));
  });
});
