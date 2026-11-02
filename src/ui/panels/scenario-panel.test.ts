import { describe, expect, it } from 'vitest';
import { scenarios } from '../../scenarios';
import { isGuided, timelineGroups } from './scenario-panel';

describe('guided scenarios', () => {
  const guided = scenarios.filter(isGuided);
  it('offers the steps scenarios, and their text carries no durations', () => {
    expect(guided.length).toBeGreaterThanOrEqual(3);
    for (const s of guided) {
      const text = [s.title, s.narrative, ...s.timeline.map((t) => t.note ?? '')].join(' ');
      expect(text, s.id).not.toMatch(/\d\s?(s|sec|secs|seconds|min|minutes)\b/i);
    }
  });
  it('groups the timeline: failure first, recovery later', () => {
    const g = timelineGroups(guided[0] as (typeof guided)[number]);
    expect(g.length).toBeGreaterThanOrEqual(2);
    expect(g[0]?.[0]?.action.kind).toBe('fail');
  });
});
