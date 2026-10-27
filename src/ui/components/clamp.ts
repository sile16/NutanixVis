import { type RefObject, useLayoutEffect, useState } from 'react';

const MARGIN = 8;

/** Keep a box of size `w`×`h` at `at` inside a `vw`×`vh` viewport (pure). */
export function clampToViewport(
  at: { x: number; y: number },
  size: { w: number; h: number },
  viewport: { w: number; h: number },
): { x: number; y: number } {
  const x = Math.max(MARGIN, Math.min(at.x, viewport.w - size.w - MARGIN));
  const y = Math.max(MARGIN, Math.min(at.y, viewport.h - size.h - MARGIN));
  return { x, y };
}

/**
 * Position a fixed popup (hover card, context menu) at `at`, moved back inside the window when it
 * would overflow the right or bottom edge. Measured after layout, so the first paint is correct.
 */
export function useClampedPosition(
  ref: RefObject<HTMLElement | null>,
  at: { x: number; y: number } | null,
): { x: number; y: number } | null {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ax = at?.x;
  const ay = at?.y;
  useLayoutEffect(() => {
    const el = ref.current;
    if (ax === undefined || ay === undefined || !el) {
      setPos(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setPos(
      clampToViewport(
        { x: ax, y: ay },
        { w: r.width, h: r.height },
        { w: window.innerWidth, h: window.innerHeight },
      ),
    );
  }, [ref, ax, ay]);
  return pos;
}
