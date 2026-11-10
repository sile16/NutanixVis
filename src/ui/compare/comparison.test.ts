import { describe, expect, it } from 'vitest';
import { guidedFor } from '../../scenarios/guided';
import { T1_CONFIGS } from '../../topologies/t1-configs';
import { COLUMNS, COMPARISON } from './comparison';

describe('topology comparison chart', () => {
  it('has a column for every offered configuration', () => {
    expect(COLUMNS.map((c) => c.key).sort()).toEqual(T1_CONFIGS.map((c) => c.key).sort());
  });

  it('links every failure cell to a guided scenario that exists on that configuration', () => {
    for (const section of COMPARISON) {
      for (const row of section.rows) {
        for (const c of T1_CONFIGS) {
          const cell = row.cells[c.key];
          expect(cell.text.length, `${row.label} / ${c.key}`).toBeGreaterThan(0);
          for (const n of cell.try ?? []) {
            const offered = guidedFor(c.catalogId).map((g) => g.family.n);
            expect(offered, `${row.label} / ${c.key} → scenario ${n}`).toContain(n);
          }
        }
      }
    }
  });

  it('gives every failure row a scenario to watch on every configuration it applies to', () => {
    const failures = COMPARISON.find((s) => s.title.startsWith('Failures'));
    for (const row of failures?.rows ?? []) {
      const linked = T1_CONFIGS.filter((c) => (row.cells[c.key].try ?? []).length > 0);
      expect(linked.length, row.label).toBeGreaterThan(0);
    }
  });

  it('speaks in steps, never in durations', () => {
    const text = COMPARISON.flatMap((s) => s.rows.flatMap((r) => Object.values(r.cells)))
      .map((c) => c.text)
      .join(' ');
    expect(text).not.toMatch(/\d\s?(s|sec|secs|seconds|min|minutes)\b/i);
  });
});
