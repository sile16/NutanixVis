import { describe, expect, it } from 'vitest';
import { createSimulation, type EngineTickContext } from '../../src/engine';
import { device, fabric, fabricDevices, probeSim, VERSIONS } from './helpers';

const OPTS = { cite: [], confidence: 'assumption' } as const;

function sim(devices: ReturnType<typeof device>[]) {
  return createSimulation({
    devices,
    profile: { answer: 42 },
    seed: 3,
    topologyId: 't',
    versions: VERSIONS,
  });
}

describe('tick phases', () => {
  it('runs hooks in phase order, devices in sorted-id order', () => {
    const log: string[] = [];
    const mk = (id: string) =>
      device(id, {
        preTick: (c) => log.push(`${c.now} pre ${id} ${c.phase}`),
        emit: () => log.push(`emit ${id}`),
        tick: () => log.push(`tick ${id}`),
        postTick: () => log.push(`post ${id}`),
      });
    const s = sim([mk('b'), mk('a')]);
    s.tick();
    expect(log).toEqual([
      '1 pre a preTick',
      '1 pre b preTick',
      'emit a',
      'emit b',
      'tick a',
      'tick b',
      'post a',
      'post b',
    ]);
  });

  it('delivers request → response → follow-up within one tick (rounds)', () => {
    const net = fabric();
    const seen: string[] = [];
    const client = device('h1.cvm', {
      parentId: 'h1',
      emit(ctx) {
        ctx.send({
          kind: 'req',
          src: 'h1.cvm.ep10',
          dst: 'tgt.ep0',
          size: 'small',
          flow: ctx.flow('h1.cvm.ep10', 'tgt.ep0'),
          payload: 0,
        });
      },
      onMessage(msg, ctx) {
        seen.push(`client got ${msg.kind} r${msg.round} t${ctx.now}`);
        if (msg.kind === 'resp') {
          ctx.send({ ...reply(ctx, msg.dst, msg.src), kind: 'ack' });
        }
      },
    });
    const server = device('tgt', {
      onMessage(msg, ctx) {
        seen.push(`server got ${msg.kind} r${msg.round}`);
        if (msg.kind === 'req') ctx.send({ ...reply(ctx, msg.dst, msg.src), kind: 'resp' });
      },
    });
    const s = createSimulation({
      devices: [device('h1'), client, server, device('h2'), device('h2.cvm', { parentId: 'h2' })],
      network: net,
      profile: null,
      seed: 1,
      topologyId: 't',
      versions: VERSIONS,
    });
    const snap = s.tick();
    expect(seen).toEqual(['server got req r0', 'client got resp r1 t1', 'server got ack r2']);
    expect(snap.traces.map((t) => [t.kind, t.round, t.result])).toEqual([
      ['req', 0, 'delivered'],
      ['resp', 1, 'delivered'],
      ['ack', 2, 'delivered'],
    ]);
  });

  it('carries messages sent in the last round over to the next tick', () => {
    const net = fabric();
    let pings = 0;
    const a = device('h1.cvm', {
      parentId: 'h1',
      emit(ctx) {
        if (ctx.now === 1) ctx.send(reply(ctx, 'h1.cvm.ep10', 'tgt.ep0'));
      },
      onMessage(msg, ctx) {
        pings++;
        ctx.send(reply(ctx, msg.dst, msg.src));
      },
    });
    const b = device('tgt', {
      onMessage(msg, ctx) {
        pings++;
        ctx.send(reply(ctx, msg.dst, msg.src));
      },
    });
    const s = createSimulation({
      devices: [device('h1'), a, b],
      network: net,
      profile: null,
      seed: 1,
      topologyId: 't',
      versions: VERSIONS,
      deliveryRounds: 2,
    });
    expect(s.tick().traces).toHaveLength(2);
    expect(pings).toBe(2);
    // The message sent in round 2 is delivered in round 1 of tick 2.
    expect(s.tick().traces.map((t) => t.round)).toEqual([2, 1]);
  });
});

function reply(ctx: EngineTickContext, src: string, dst: string) {
  return { kind: 'ping', src, dst, size: 'small' as const, flow: ctx.flow(src, dst), payload: 0 };
}

describe('timers in the simulation', () => {
  it('a 5 s timer set at T=1 fires in the tick phase of T=6, not T=5', () => {
    const fired: number[] = [];
    const order: string[] = [];
    const d = device('d', {
      emit(ctx) {
        if (ctx.now === 1) {
          ctx.timers.set('t5', 5, OPTS, () => {
            fired.push(ctx.now);
            order.push(`timer ${ctx.phase}`);
          });
        }
      },
      tick(ctx) {
        if (ctx.now === 6) order.push('device tick');
      },
    });
    const s = sim([d]);
    expect(s.tick().nextTimerAt).toBe(6);
    s.tick(4);
    expect(fired).toEqual([]);
    expect(s.getSnapshot().simTime).toBe(5);
    s.tick();
    expect(fired).toEqual([6]);
    expect(order).toEqual(['timer tick', 'device tick']);
    expect(s.getSnapshot().nextTimerAt).toBeNull();
  });

  it('runUntilNextTimer advances to the soonest timer, bounded by maxTicks', () => {
    let fired = false;
    const d = device('d', {
      emit(ctx) {
        if (ctx.now === 1) ctx.timers.set('detach', 1800, OPTS, () => (fired = true));
      },
    });
    const s = sim([d]);
    s.tick();
    expect(s.runUntilNextTimer(10).simTime).toBe(11);
    expect(fired).toBe(false);
    const snap = s.runUntilNextTimer();
    expect(snap.simTime).toBe(1801);
    expect(fired).toBe(true);
    expect(s.runUntilNextTimer().simTime).toBe(1801); // nothing pending: no-op
  });
});

describe('device failure', () => {
  it('skips hooks of failed devices and their children, cancels their timers, calls lifecycle', () => {
    const calls: string[] = [];
    const host = device('h', {
      onFail: () => calls.push('h fail'),
      onRecover: () => calls.push('h recover'),
    });
    const child = device('h.child', {
      parentId: 'h',
      emit(ctx) {
        calls.push(`child emit ${ctx.now}`);
        if (ctx.now === 1) ctx.timers.set('never', 3, OPTS, () => calls.push('timer!'));
      },
      onFail: () => calls.push('child fail'),
      onRecover: () => calls.push('child recover'),
    });
    const s = sim([host, child]);
    s.tick();
    s.applyAction({ kind: 'fail', target: 'h' });
    const snap = s.tick();
    expect(snap.devices.h?.status).toBe('failed');
    expect(snap.devices['h.child']?.status).toBe('offline');
    s.tick(5);
    s.applyAction({ kind: 'recover', target: 'h' });
    s.tick();
    expect(calls).toEqual([
      'child emit 1',
      'h fail',
      'child fail',
      'h recover',
      'child recover',
      'child emit 8',
    ]);
    expect(s.isDown('h.child')).toBe(false);
  });

  it('endpoints and NICs go down with their owning device', () => {
    const s = probeSim(fabric(), [{ src: 'tgt.ep0', dst: 'h1.cvm.ep10' }]);
    s.applyAction({ kind: 'fail', target: 'h1.cvm' });
    let t = s.tick().traces[0];
    expect([t?.result, t?.reason, t?.dropAt]).toEqual(['dropped', 'device-down', 'h1.cvm']);
    s.applyAction({ kind: 'recover', target: 'h1.cvm' });
    s.applyAction({ kind: 'fail', target: 'h1' });
    const snap = s.tick();
    t = snap.traces[0];
    expect(t?.result).toBe('dropped');
    expect(snap.devices['h1.eth0']?.status).toBe('offline');
    expect(snap.links['l-h1-eth0']?.status).toBe('down');
  });
});

describe('facade', () => {
  it('rejects duplicate device ids', () => {
    expect(() => sim([device('x'), device('x')])).toThrow(/duplicate/);
  });

  it('exposes the profile, a per-device rng and the previous snapshot', () => {
    const seen: unknown[] = [];
    const d = device('d', {
      preTick: (c) => seen.push(c.profile, c.prev.simTime, c.rng.int(0, 1000)),
    });
    const s1 = sim([d]);
    s1.tick(2);
    const again: unknown[] = [];
    const s2 = sim([
      device('d', { preTick: (c) => again.push(c.profile, c.prev.simTime, c.rng.int(0, 1000)) }),
    ]);
    s2.tick(2);
    expect(seen).toEqual(again);
    expect(seen[0]).toEqual({ answer: 42 });
    expect(seen[1]).toBe(0);
    expect(seen[4]).toBe(1);
  });

  it('merges device-provided derived state into the snapshot', () => {
    const d = {
      ...device('d'),
      derived: () => ({ zkQuorum: true, ha: { status: 'OK' } }),
    };
    const s = createSimulation({
      devices: [d],
      profile: null,
      seed: 1,
      topologyId: 't',
      versions: VERSIONS,
    });
    expect(s.tick().derived).toMatchObject({ zkQuorum: true, ha: { status: 'OK' } });
  });

  it('fabricDevices helper wires parent links', () => {
    expect(fabricDevices().find((d) => d.id === 'h1.cvm')?.parentId).toBe('h1');
  });
});
