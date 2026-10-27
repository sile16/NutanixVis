import { describe, expect, it } from 'vitest';
import { clampToViewport } from './clamp';

describe('clampToViewport', () => {
  const vp = { w: 1000, h: 600 };
  it('keeps a popup that fits where it is', () => {
    expect(clampToViewport({ x: 100, y: 100 }, { w: 200, h: 100 }, vp)).toEqual({ x: 100, y: 100 });
  });
  it('moves a popup back inside the right and bottom edges', () => {
    expect(clampToViewport({ x: 950, y: 580 }, { w: 200, h: 100 }, vp)).toEqual({ x: 792, y: 492 });
  });
});
