import { describe, expect, it } from 'vitest';
import { deepFreeze } from '../../src/engine';
import { device, fabric, probeSim } from './helpers';

describe('snapshot', () => {
  it('is deeply frozen', () => {
    const s = probeSim(fabric(), [{ src: 'h1.cvm.ep10', dst: 'tgt.ep0' }]);
    const snap = s.tick();
    const view = snap.devices['h1.vs1'];
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.devices)).toBe(true);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view?.fields)).toBe(true);
    expect(Object.isFrozen(snap.links['l-isl']?.util)).toBe(true);
    expect(Object.isFrozen(snap.traces[0]?.links)).toBe(true);
    expect(Object.isFrozen(snap.derived)).toBe(true);
    expect(() => {
      (snap as { simTime: number }).simTime = 99;
    }).toThrow(TypeError);
  });

  it('does not freeze device-owned objects returned from view()', () => {
    const fields: Record<string, number> = { n: 0 };
    const d = device('d', { fields: () => fields });
    const s = probeSim({}, [], { devices: [d] });
    const snap = s.tick();
    fields.n = 1;
    expect(snap.devices.d?.fields.n).toBe(0);
    expect(s.tick().devices.d?.fields.n).toBe(1);
  });

  it('bumps version per tick and per queued action, and notifies subscribers', () => {
    const s = probeSim(fabric(), []);
    const seen: number[] = [];
    const unsubscribe = s.subscribe(() => seen.push(s.getSnapshot().version));
    const v0 = s.getSnapshot().version;
    expect(s.getSnapshot()).toBe(s.getSnapshot()); // stable reference for useSyncExternalStore
    s.tick();
    s.applyAction({ kind: 'link-down', target: 'l-isl' });
    expect(s.getSnapshot().derived['engine.queuedActions']).toBe(1);
    expect(s.getSnapshot().simTime).toBe(1); // queued, not applied
    s.tick(2);
    expect(seen).toEqual([v0 + 1, v0 + 2, v0 + 3, v0 + 4]);
    unsubscribe();
    s.tick();
    expect(seen).toHaveLength(4);
    expect(s.getSnapshot().links['l-isl']?.status).toBe('down');
  });

  it('carries the run identity and last-tick events only', () => {
    const s = probeSim(fabric(), []);
    s.applyAction({ kind: 'link-down', target: 'l-isl' });
    const snap = s.tick();
    expect(snap).toMatchObject({ seed: 1, topologyId: 'test', simTime: 1 });
    expect(snap.events.map((e) => e.code)).toEqual(['action.link-down', 'net.link.down']);
    expect(s.tick().events).toEqual([]);
    expect(s.eventLog()).toHaveLength(2);
  });

  it('deepFreeze handles nested arrays and is idempotent', () => {
    const o = deepFreeze({ a: [{ b: 1 }], c: { d: [2] } });
    expect(Object.isFrozen(o.a[0])).toBe(true);
    expect(Object.isFrozen(o.c.d)).toBe(true);
    expect(deepFreeze(o)).toBe(o);
  });
});
