import { describe, expect, it } from 'vitest';
import type { Snapshot, Trace } from '../../engine/types';
import { t1Steady } from '../../fixtures/snapshots/t1-steady';
import { buildActivityWindow, glowOpacity } from './activity-window';

const at = (simTime: number, traces: Trace[]): Snapshot => ({ ...t1Steady, simTime, traces });
const tr = (id: string, links: string[], category = 'io-read'): Trace => ({
  msgId: id,
  kind: 'nvme-io',
  category,
  round: 0,
  links,
  result: 'delivered',
});

describe('buildActivityWindow', () => {
  it('keeps links active across ticks when round-robin alternates paths', () => {
    const w = buildActivityWindow([
      at(1, [tr('a', ['l-n1-eth1', 'l-ct0-eth10'])]),
      at(2, [tr('b', ['l-n1-eth1', 'l-ct1-eth10'])]),
    ]);
    expect(w.links.get('l-ct0-eth10')?.age).toBe(1);
    expect(w.links.get('l-ct1-eth10')?.age).toBe(0);
    expect(w.links.get('l-n1-eth1')?.count).toBe(2);
    expect(w.snapshot.traces).toHaveLength(2);
    expect(w.snapshot.simTime).toBe(2);
  });

  it('sums link utilization over the window', () => {
    const w = buildActivityWindow([at(1, []), at(2, [])]);
    expect(w.snapshot.links['l-n1-eth1']?.util['nvme-io']).toBe(24);
  });

  it('picks the most frequent category per link', () => {
    const w = buildActivityWindow([
      at(1, [tr('a', ['l-isl'], 'keepalive'), tr('b', ['l-isl'], 'io-write')]),
      at(2, [tr('c', ['l-isl'], 'io-write')]),
    ]);
    expect(w.links.get('l-isl')?.category).toBe('io-write');
  });
});

describe('glowOpacity', () => {
  it('fades with age and is constant for a one-tick window', () => {
    expect(glowOpacity(0, 10)).toBeGreaterThan(glowOpacity(9, 10));
    expect(glowOpacity(0, 1)).toBe(glowOpacity(5, 1));
  });
});
