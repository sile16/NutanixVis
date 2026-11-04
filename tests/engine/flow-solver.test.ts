import { describe, expect, it } from 'vitest';
import {
  type DirCapacity,
  type FlowDemand,
  type FlowPath,
  solveFlows,
} from '../../src/engine/network/flow-solver';

const G = 1e9;
const MB = 8e6;
const cap = (gbps: number, bufferMB = 32): DirCapacity => ({
  bps: gbps * G,
  bufferBits: bufferMB * MB,
});
const path = (id: string, up: string[], down: string[], hops = 1): FlowPath => ({
  id,
  routes: [{ weight: 1, up, down, switchHops: hops }],
});
const flow = (over: Partial<FlowDemand> & Pick<FlowDemand, 'id' | 'paths'>): FlowDemand => ({
  capBps: null,
  outstandingBits: 32 * 256 * 1024 * 8,
  readFraction: 0.5,
  selector: 'queue-depth',
  baseLatencyS: 200e-6,
  ...over,
});
const P = { hopLatencyS: 1e-6 };

describe('flow solver', () => {
  it('below line rate: no queue, the flow gets its offered load', () => {
    const c = new Map([
      ['l>up', cap(100)],
      ['l>down', cap(100)],
    ]);
    const s = solveFlows(
      c,
      [flow({ id: 'f', capBps: 40 * G, paths: [path('p', ['l>up'], ['l>down'])] })],
      P,
    );
    expect(s.flows.get('f')?.bps).toBeCloseTo(40 * G, -6);
    expect(s.dirs.get('l>up')?.delayS).toBe(0);
    expect(s.dirs.get('l>down')?.servedBps).toBeCloseTo(20 * G, -6);
  });

  it('over line rate: a queue builds until the closed loop fits the link, and latency rises', () => {
    const c = new Map([
      ['l>up', cap(50)],
      ['l>down', cap(50)],
    ]);
    const f = flow({ id: 'f', readFraction: 1, paths: [path('p', ['l>up'], ['l>down'])] });
    const s = solveFlows(c, [f], P);
    const down = s.dirs.get('l>down');
    expect(down?.servedBps).toBeCloseTo(50 * G, -8);
    expect(down?.dropBps ?? 0).toBeLessThan(0.01 * G);
    expect(down?.delayS).toBeGreaterThan(0);
    // Little's law: outstanding / latency = rate.
    const r = s.flows.get('f');
    expect(f.outstandingBits / (r?.latencyS ?? 1) / G).toBeCloseTo(50, 0);
    expect(r?.latencyS).toBeGreaterThan(f.baseLatencyS * 2);
  });

  it('queue-depth selector moves load off a congested path; round-robin does not', () => {
    // Two paths: a local one, and a far one that shares a 30 Gb-per-direction link with a second flow.
    const c = new Map([
      ['local>up', cap(100)],
      ['local>down', cap(100)],
      ['isl>up', cap(30)],
      ['isl>down', cap(30)],
    ]);
    const paths = [
      path('local', ['local>up'], ['local>down']),
      path('far', ['isl>up'], ['isl>down'], 2),
    ];
    const other = flow({
      id: 'other',
      capBps: 50 * G,
      paths: [path('o', ['isl>up'], ['isl>down'])],
    });
    const run = (selector: FlowDemand['selector']) =>
      solveFlows(c, [flow({ id: 'f', capBps: 80 * G, selector, paths }), other], P);
    const qd = run('queue-depth').flows.get('f');
    const rr = run('round-robin').flows.get('f');
    expect(qd?.pathBps.local ?? 0).toBeGreaterThan((qd?.pathBps.far ?? 0) * 1.5);
    expect(rr?.pathBps.local).toBeCloseTo(rr?.pathBps.far ?? -1, -6);
    // Round-robin is held back by the slow path; queue-depth keeps more of its offered load.
    expect(qd?.bps ?? 0).toBeGreaterThan(rr?.bps ?? 0);
  });

  it('extra switch hops alone shift a little load to the shorter path', () => {
    const c = new Map([
      ['a>up', cap(100)],
      ['a>down', cap(100)],
      ['b>up', cap(100)],
      ['b>down', cap(100)],
    ]);
    const s = solveFlows(
      c,
      [
        flow({
          id: 'f',
          capBps: 20 * G,
          paths: [path('near', ['a>up'], ['a>down'], 1), path('far', ['b>up'], ['b>down'], 2)],
        }),
      ],
      P,
    );
    const r = s.flows.get('f');
    expect(r?.pathBps.near ?? 0).toBeGreaterThan(r?.pathBps.far ?? 0);
    expect((r?.pathBps.near ?? 0) / (r?.pathBps.far ?? 1)).toBeLessThan(1.02);
  });

  it('a buffer too small for the overload drops the excess and cuts the flows to the line rate', () => {
    const c = new Map([
      ['l>up', cap(50, 0.01)],
      ['l>down', cap(50, 0.01)],
    ]);
    const s = solveFlows(
      c,
      [flow({ id: 'f', readFraction: 1, paths: [path('p', ['l>up'], ['l>down'])] })],
      P,
    );
    expect(s.dirs.get('l>down')?.servedBps).toBeCloseTo(50 * G, -8);
    expect(s.dirs.get('l>down')?.dropBps ?? 0).toBeGreaterThan(0);
    expect(s.flows.get('f')?.bps).toBeCloseTo(50 * G, -8);
  });
});
