import { describe, expect, it } from 'vitest';
import { linkGeometry } from './geometry';
import { anchorBelow, anchorOutside } from './label-anchor';

describe('label anchors', () => {
  // A NIC port at the bottom of a host frame, cabled straight down to a switch 200 px below.
  const g = linkGeometry({ x: 100, y: 100, side: 'bottom' }, { x: 100, y: 300, side: 'top' });
  const host = { x: 0, y: 0, w: 300, h: 108 };

  it('sits just outside the frame that owns the port, on the cable', () => {
    const a = anchorOutside(g, true, host, 12);
    expect(a.place).toBe('center');
    expect(a.x).toBeCloseTo(100, 0);
    expect(a.y).toBeGreaterThan(108);
    expect(a.y).toBeLessThan(126);
  });

  it('walks from the other end when the port is the target', () => {
    const switchFrame = { x: 0, y: 290, w: 300, h: 60 };
    const a = anchorOutside(g, false, switchFrame, 12);
    expect(a.y).toBeLessThan(290);
    expect(a.y).toBeGreaterThan(270);
  });

  it('hangs the interconnect label below both switches', () => {
    const isl = linkGeometry({ x: 400, y: 30, side: 'right' }, { x: 500, y: 30, side: 'left' });
    const a = anchorBelow(isl, { x: 0, y: 0, w: 400, h: 60 }, { x: 500, y: 0, w: 400, h: 60 });
    expect(a).toEqual({ x: 450, y: 66, place: 'below' });
  });
});
