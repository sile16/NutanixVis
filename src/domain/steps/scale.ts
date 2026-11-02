/**
 * The relative step scale. A step is NOT a fixed number of seconds, and not a fixed stage: it is a
 * slot on a compressive (geometric) scale of the time since the interruption began. Each slot is
 * twice as long as the one before it, after a first slot, so
 * - things that happen close together (a stall, the Hades chain, a redirect) land in nearby steps,
 *   while a wait that is an order of magnitude longer (the sessions failing back) spans a handful
 *   more steps, not hundreds;
 * - the order and the relative gaps come from the simulated components' own timers; nothing here
 *   names a stage.
 *
 * The scale is in engine ticks internally. The UI never prints ticks or equates a step with
 * seconds.
 */

/** Length of the first step, in engine ticks. */
export const FIRST_STEP_TICKS = 10;

/** Elapsed ticks (since the interruption began) at which step `k` (1-based) starts. */
export function stepBoundary(k: number): number {
  return k <= 1 ? 0 : FIRST_STEP_TICKS * 2 ** (k - 2);
}

/** The step (1-based) containing `elapsed` ticks since the interruption began. */
export function stepOfElapsed(elapsed: number): number {
  let k = 1;
  while (elapsed >= stepBoundary(k + 1)) k++;
  return k;
}
