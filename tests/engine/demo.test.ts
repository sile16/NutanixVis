/**
 * Headless demo: two hosts, each with a 2-NIC bond to switches A and B (ISL between them), and a
 * two-port target. Each host's CVM sends a request to both target ports every tick and the target
 * answers. A switch failure must show up in traces, utilization and the event chain.
 */
import { describe, expect, it } from 'vitest';
import { createSimulation, type EngineTrace } from '../../src/engine';
import { device, fabric, VERSIONS } from './helpers';

const TARGETS = ['tgt.ep0', 'tgt.ep1'];

function demo() {
  const replies = new Map<string, number>();
  const cvm = (host: string) => {
    const ep = `${host}.cvm.ep10`;
    return device(`${host}.cvm`, {
      parentId: host,
      emit(ctx) {
        for (const dst of TARGETS) {
          ctx.send({
            kind: 'req',
            src: ep,
            dst,
            size: 'large',
            flow: ctx.flow(ep, dst, { srcPort: 50000, dstPort: 4420 }),
            payload: null,
          });
        }
      },
      onMessage(msg) {
        if (msg.kind === 'resp')
          replies.set(`${msg.dst}<${msg.src}`, (replies.get(`${msg.dst}<${msg.src}`) ?? 0) + 1);
      },
    });
  };
  const target = device('tgt', {
    onMessage(msg, ctx) {
      ctx.send({
        kind: 'resp',
        src: msg.dst,
        dst: msg.src,
        size: 'small',
        flow: ctx.flow(msg.dst, msg.src, { srcPort: 4420, dstPort: msg.flow.srcPort }),
        payload: null,
        causeId: msg.id,
      });
    },
  });
  const sim = createSimulation({
    devices: [device('h1'), cvm('h1'), device('h2'), cvm('h2'), target],
    network: fabric(),
    profile: null,
    seed: 2026,
    topologyId: 'demo',
    versions: VERSIONS,
    traffic: { req: 'io-write', resp: 'io-ack' },
  });
  return { sim, replies };
}

const pathOf = (ts: readonly EngineTrace[], src: string, dst: string) =>
  ts.find((t) => t.src === src && t.dst === dst);

describe('headless demo: switch failure', () => {
  it('steady state: all requests and responses delivered, ISL used for the far port', () => {
    const { sim, replies } = demo();
    const snap = sim.tick();
    const ts = snap.traces as readonly EngineTrace[];
    expect(ts).toHaveLength(8);
    expect(ts.every((t) => t.result === 'delivered')).toBe(true);
    expect(pathOf(ts, 'h1.cvm.ep10', 'tgt.ep1')?.links).toEqual(['l-h1-eth0', 'l-isl', 'l-tgt-p1']);
    expect(pathOf(ts, 'tgt.ep1', 'h2.cvm.ep10')?.links).toEqual(['l-tgt-p1', 'l-isl', 'l-h2-eth0']);
    expect(snap.links['l-isl']?.util).toEqual({ 'io-ack': 2, 'io-write': 2 });
    expect(snap.links['l-h1-eth0']?.util).toEqual({ 'io-ack': 2, 'io-write': 2 });
    expect(snap.links['l-h1-eth1']?.util).toEqual({});
    expect(replies.get('h1.cvm.ep10<tgt.ep1')).toBe(1);
  });

  it('switch A fails: bonds fail over to B, the A-side target port is lost, events chain', () => {
    const { sim, replies } = demo();
    sim.tick(3);
    sim.applyAction({ kind: 'fail', target: 'sw-a' });
    const snap = sim.tick();
    const ts = snap.traces as readonly EngineTrace[];

    // Traces: B-side port still answers via each host's eth1; A-side port is unreachable.
    expect(pathOf(ts, 'h1.cvm.ep10', 'tgt.ep1')).toMatchObject({
      result: 'delivered',
      links: ['l-h1-eth1', 'l-tgt-p1'],
    });
    expect(pathOf(ts, 'h2.cvm.ep10', 'tgt.ep0')).toMatchObject({
      result: 'dropped',
      reason: 'device-down',
      dropAt: 'sw-a',
      links: ['l-h2-eth1', 'l-isl'],
    });
    expect(ts.filter((t) => t.result === 'delivered')).toHaveLength(4);

    // Utilization moved off switch A.
    expect(snap.links['l-h1-eth0']).toMatchObject({ status: 'down', util: {} });
    expect(snap.links['l-h1-eth1']?.util).toEqual({ 'io-ack': 1, 'io-write': 2 });
    // A-bound requests die crossing the ISL into the failed switch, so it carries nothing.
    expect(snap.links['l-isl']?.util).toEqual({});
    expect(snap.links['l-tgt-p0']?.status).toBe('down');

    // Events: action → device failed → links down → bond failovers, causally linked.
    const codes = snap.events.map((e) => e.code);
    expect(codes.slice(0, 2)).toEqual(['action.fail', 'device.failed']);
    expect(codes.filter((c) => c === 'net.link.down')).toHaveLength(4);
    const failovers = snap.events.filter((e) => e.code === 'net.bond.failover');
    expect(failovers.map((e) => e.deviceId)).toEqual(['h1.vs1', 'h2.vs1']);
    for (const f of failovers) {
      expect(sim.causalChain(`e${f.seq}`).map((e) => e.code)).toEqual([
        'action.fail',
        'device.failed',
        'net.link.down',
        'net.bond.failover',
      ]);
    }
    expect(snap.devices['sw-a']?.status).toBe('failed');
    expect(snap.devices['h1.vs1']?.status).toBe('degraded');
    expect(replies.get('h1.cvm.ep10<tgt.ep0')).toBe(3);

    // Recovery: links come back, active members stay on B (no failback).
    sim.applyAction({ kind: 'recover', target: 'sw-a' });
    const back = sim.tick();
    const bts = back.traces as readonly EngineTrace[];
    expect(bts.every((t) => t.result === 'delivered')).toBe(true);
    expect(pathOf(bts, 'h1.cvm.ep10', 'tgt.ep0')?.links).toEqual([
      'l-h1-eth1',
      'l-isl',
      'l-tgt-p0',
    ]);
    expect(replies.get('h1.cvm.ep10<tgt.ep0')).toBe(4);
  });
});
