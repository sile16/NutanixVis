/**
 * Seeded PRNG (SPEC §5.1 "Determinism"): mulberry32. Nothing in the engine reads `Math.random`
 * or the wall clock, so the same seed always yields the same run.
 */
import { fnv1a } from './hash';
import type { Rng } from './types';

export interface SeededRng extends Rng {
  readonly seed: number;
  /**
   * An independent stream derived from this seed and `label` (e.g. a device id). Per-device
   * streams keep one device's draws from shifting another's when devices are added.
   */
  fork(label: string): SeededRng;
}

export function createRng(seed: number): SeededRng {
  if (!Number.isFinite(seed)) throw new RangeError(`rng seed must be finite, got ${seed}`);
  const base = seed >>> 0;
  let state = base;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    seed: base,
    next,
    int(min: number, max: number): number {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new RangeError(`rng.int needs integers min <= max, got [${min}, ${max}]`);
      }
      return min + Math.floor(next() * (max - min + 1));
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('rng.pick from an empty list');
      return items[Math.floor(next() * items.length)] as T;
    },
    fork(label: string): SeededRng {
      return createRng(fnv1a(`${base}:${label}`));
    },
  };
}
