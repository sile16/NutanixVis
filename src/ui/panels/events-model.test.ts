import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../engine/types';
import { causalChain, eventId, filterEvents, indexEvents } from './events-model';

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
