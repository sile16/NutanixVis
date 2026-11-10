import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../engine/types';
import { loadSimulation } from '../../loader/simulation';
import { causalChain, eventId, filterEvents, indexEvents, readableText } from './events-model';

const ev = (seq: number, over: Partial<SimEvent> = {}): SimEvent => ({
  seq,
  t: seq,
  severity: 'info',
  code: `c${seq}`,
  text: `event ${seq}`,
  causeIds: [],
  cite: [],
  ...over,
});

const log = [
  ev(1, { severity: 'error', deviceId: 'sw-a' }),
  ev(2, { severity: 'warn', deviceId: 'node-1.vs1', causeIds: ['e1'] }),
  ev(3, { severity: 'info', deviceId: 'node-1.cvm', causeIds: ['e2', 'e1'] }),
  ev(4, { severity: 'debug' }),
  ev(5, { causeIds: ['e5'] }),
];

describe('events model', () => {
  it('filters by minimum severity', () => {
    expect(filterEvents(log, { minSeverity: 'warn', deviceId: null }).map((e) => e.seq)).toEqual([
      1, 2,
    ]);
    expect(filterEvents(log, { minSeverity: 'debug', deviceId: null })).toHaveLength(5);
  });

  it('filters by device, including descendants when given a predicate', () => {
    const within = (d: string, a: string) => d === a || d.startsWith(`${a}.`);
    expect(
      filterEvents(log, { minSeverity: 'debug', deviceId: 'node-1' }, within).map((e) => e.seq),
    ).toEqual([2, 3]);
    expect(filterEvents(log, { minSeverity: 'debug', deviceId: 'node-1' })).toEqual([]);
  });

  it('walks the causal chain root-first and survives cycles', () => {
    const index = indexEvents(log);
    expect(eventId(log[0] as SimEvent)).toBe('e1');
    expect(causalChain(log[2] as SimEvent, index).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(causalChain(log[4] as SimEvent, index).map((e) => e.seq)).toEqual([5]);
  });
});

describe('readableText', () => {
  const snap = loadSimulation({ topologyId: 't1-ahv-flasharray', options: {}, seed: 1 }).sim.tick(
    1,
  );
  const read = (t: string) => readableText(t, snap.devices, snap.links);

  it('names NVMe paths, devices and cables, and leaves unknown ids alone', () => {
    expect(
      read('node-1.cvm.storage-a~fa.ct1.eth10.v10 lost: no keep-alive response within KATO'),
    ).toBe('CVM-IP A → CT1 eth10 (VLAN 10) lost: no keep-alive response within KATO');
    expect(read('node-1.cvm took over node-1.vm-1.vdisk-1 from node-2.cvm.')).toBe(
      'CVM 1 took over node-1.vm-1.vdisk-1 from CVM 2.',
    );
    expect(read('Switch B → eth3 is at line rate (50 Gb/s)')).toBe(
      'Switch B → eth3 is at line rate (50 Gb/s)',
    );
    const cable = Object.keys(snap.links).find((id) => id.includes('node-1.eth2'));
    expect(cable && read(`${cable} down`)).toMatch(/^Node 1 eth2 ↔ Switch A/);
  });
});
