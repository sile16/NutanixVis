import { describe, expect, it } from 'vitest';
import { loadSimulation } from '../../loader/simulation';
import { SnapshotHistory } from './snapshot-history';

const sim = () =>
  loadSimulation({ topologyId: 't2-hci-ahv', versions: { nutanix: 'aos-7.6' } }).sim;

describe('SnapshotHistory', () => {
  it('records every tick of a batched step (×60 runs 12 ticks per render)', () => {
    const s = sim();
    const h = new SnapshotHistory(s);
    s.tick(12);
    expect(h.last(30).map((x) => x.simTime)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(h.last(5).map((x) => x.simTime)).toEqual([8, 9, 10, 11, 12]);
  });

  it('replaces the current tick when an action is queued (same simTime, new version)', () => {
    const s = sim();
    const h = new SnapshotHistory(s);
    s.tick(2);
    s.applyAction({ kind: 'fail', target: 'sw-a' });
    const last = h.last(30);
    expect(last.map((x) => x.simTime)).toEqual([0, 1, 2]);
    expect(last[last.length - 1]).toBe(s.getSnapshot());
  });

  it('keeps at most `max` ticks', () => {
    const s = sim();
    const h = new SnapshotHistory(s, 4);
    s.tick(10);
    expect(h.last(30).map((x) => x.simTime)).toEqual([7, 8, 9, 10]);
  });

  it('starts over when time goes backwards', () => {
    const s = sim();
    const h = new SnapshotHistory(s);
    s.tick(5);
    h.record({ ...s.getSnapshot(), simTime: 0 });
    expect(h.last(30).map((x) => x.simTime)).toEqual([0]);
  });
});
