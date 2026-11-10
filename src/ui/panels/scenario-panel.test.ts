import { describe, expect, it } from 'vitest';
import { scenarios } from '../../scenarios';
import { isGuided, noStallInWindow, timelineGroups } from './scenario-panel';

describe('guided scenarios', () => {
  const guided = scenarios.filter(isGuided);
  it('offers the steps scenarios, and their text carries no durations', () => {
    expect(guided.length).toBeGreaterThanOrEqual(3);
    for (const s of guided) {
      const text = [s.title, s.narrative, ...s.timeline.map((t) => t.note ?? '')].join(' ');
      expect(text, s.id).not.toMatch(/\d\s?(s|sec|secs|seconds|min|minutes)\b/i);
    }
  });
  it('every guided scenario has a tour: one observation list per timeline group, no durations', () => {
    for (const s of guided) {
      expect(s.guide, s.id).toBeDefined();
      expect(s.guide?.groups.length, s.id).toBe(timelineGroups(s).length);
      const text =
        s.guide?.groups
          .flat()
          .map((o) => o.text)
          .join(' ') ?? '';
      expect(text, s.id).not.toMatch(/\d\s?(s|sec|secs|seconds|min|minutes)\b/i);
      // Step numbers only for the first group: later ones depend on when they are applied.
      expect(
        s.guide?.groups
          .slice(1)
          .flat()
          .every((o) => o.step === undefined),
        s.id,
      ).toBe(true);
    }
  });
  it('groups the timeline: failure first, recovery later', () => {
    const g = timelineGroups(guided[0] as (typeof guided)[number]);
    expect(g.length).toBeGreaterThanOrEqual(2);
    expect(g[0]?.[0]?.action.kind).toBe('fail');
  });
});

describe('guided "no IO stalls" notes', () => {
  it('judge each group on its own window, every stall counted', () => {
    // Group 0 applied at 10, group 1 at 50; stalls began at 12 (resumed) and 55 (resumed).
    const trouble = [12, 55];
    expect(noStallInWindow(10, 50, 60, null, trouble)).toBe(false); // group 0 stalled
    expect(noStallInWindow(50, undefined, 60, null, trouble)).toBe(false); // the second stall counts
    expect(noStallInWindow(50, undefined, 60, null, [12])).toBe(true); // group 1 itself was quiet
    // A stall open now that began in group 1 does not un-tick group 0.
    expect(noStallInWindow(10, 50, 60, 55, [55])).toBe(true);
    expect(noStallInWindow(50, undefined, 60, 55, [55])).toBe(false);
    // Nothing has run since the group was applied yet.
    expect(noStallInWindow(50, undefined, 50, null, [])).toBe(false);
  });
});
