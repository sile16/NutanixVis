import { describe, expect, it } from 'vitest';
import { createRng, EventLog, TimerQueue } from '../../src/engine';

describe('rng', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const seqA = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 20 }, () => c.next())).not.toEqual(seqA);
    for (const x of seqA) expect(x >= 0 && x < 1).toBe(true);
  });

  it('int() is inclusive and covers the range; pick() returns members', () => {
    const r = createRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const v = r.int(1, 6);
      expect(v >= 1 && v <= 6 && Number.isInteger(v)).toBe(true);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(['x', 'y']).toContain(r.pick(['x', 'y']));
    expect(() => r.pick([])).toThrow(RangeError);
    expect(() => r.int(3, 1)).toThrow(RangeError);
  });

  it('fork() gives independent, reproducible streams', () => {
    const f1 = createRng(1).fork('dev-a');
    const f2 = createRng(1).fork('dev-a');
    const g = createRng(1).fork('dev-b');
    const s1 = [f1.next(), f1.next()];
    expect([f2.next(), f2.next()]).toEqual(s1);
    expect([g.next(), g.next()]).not.toEqual(s1);
  });
});

describe('timers', () => {
  it('fires exactly at now + seconds, never earlier', () => {
    let now = 10;
    const q = new TimerQueue(() => now);
    const fired: number[] = [];
    const h = q.set('dev', 'kato', 5, { cite: [], confidence: 'verified' }, () => fired.push(now));
    expect(h.dueAt).toBe(15);
    for (now = 11; now <= 14; now++) q.fireDue(now);
    expect(fired).toEqual([]);
    now = 15;
    q.fireDue(now);
    expect(fired).toEqual([15]);
    expect(q.pending()).toEqual([]);
  });

  it('orders by due time then creation, supports cancel and owner scoping', () => {
    let now = 0;
    const q = new TimerQueue(() => now);
    const order: string[] = [];
    const opts = { cite: [], confidence: 'assumption' } as const;
    q.set('a', 'late', 3, opts, () => order.push('late'));
    q.set('b', 'first', 2, opts, () => order.push('first'));
    const dropped = q.set('a', 'cancelled', 2, opts, () => order.push('cancelled'));
    q.set('a', 'second', 2, opts, () => order.push('second'));
    q.cancel(dropped);
    expect(q.nextDueAt()).toBe(2);
    expect(
      q
        .api('a')
        .pending()
        .map((t) => t.name),
    ).toEqual(['second', 'late']);
    now = 3;
    q.fireDue(now);
    expect(order).toEqual(['first', 'second', 'late']);
    expect(q.nextDueAt()).toBeNull();
  });

  it('rejects seconds < 1 and rounds fractions up', () => {
    const q = new TimerQueue(() => 0);
    const opts = { cite: [], confidence: 'assumption' } as const;
    expect(() => q.set('x', 'zero', 0, opts, () => {})).toThrow(RangeError);
    expect(() => q.set('x', 'nan', Number.NaN, opts, () => {})).toThrow(RangeError);
    expect(q.set('x', 'frac', 1.2, opts, () => {}).dueAt).toBe(2);
  });

  it('a callback can cancel a later timer due in the same pass', () => {
    const q = new TimerQueue(() => 0);
    const opts = { cite: [], confidence: 'assumption' } as const;
    const fired: string[] = [];
    let second: ReturnType<typeof q.set> | undefined;
    q.set('x', 'a', 1, opts, () => {
      fired.push('a');
      if (second) q.cancel(second);
    });
    second = q.set('x', 'b', 1, opts, () => fired.push('b'));
    q.set('x', 'c', 1, opts, () => fired.push('c'));
    q.fireDue(1);
    expect(fired).toEqual(['a', 'c']);
  });
});

describe('event log', () => {
  it('assigns increasing seq ids and freezes events', () => {
    const log = new EventLog();
    const a = log.append(1, { severity: 'info', code: 'a', text: 'A', causeIds: [], cite: [] });
    const b = log.append(2, { severity: 'warn', code: 'b', text: 'B', causeIds: [a], cite: ['x'] });
    expect([a, b]).toEqual(['e1', 'e2']);
    const ev = log.get(b);
    expect(ev?.seq).toBe(2);
    expect(ev?.t).toBe(2);
    expect(Object.isFrozen(ev)).toBe(true);
    expect(Object.isFrozen(ev?.causeIds)).toBe(true);
    expect(log.since(1).map((e) => e.code)).toEqual(['b']);
  });

  it('requires causes to precede effects and walks the causal chain', () => {
    const log = new EventLog();
    const e = (code: string, causeIds: string[]) =>
      log.append(0, { severity: 'info', code, text: code, causeIds, cite: [] });
    const root = e('root', []);
    const mid = e('mid', [root, 'm7']); // message ids are allowed as causes
    e('unrelated', []);
    const leaf = e('leaf', [mid]);
    expect(log.causalChain(leaf).map((x) => x.code)).toEqual(['root', 'mid', 'leaf']);
    expect(() => e('bad', ['e99'])).toThrow(/does not precede/);
    expect(() => e('self', [`e${log.size + 1}`])).toThrow(/does not precede/);
  });
});
