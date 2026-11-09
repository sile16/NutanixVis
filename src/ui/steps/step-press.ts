/**
 * One press of the Step button (UI-only, headless so it can be tested). A press runs through the
 * NEXT step of the current incident: it ticks until the counter moves to a new step, then keeps
 * going to the end of that step, so everything that happened in it (a maintenance entry, a
 * redirect, the IO resuming) is on screen when the counter shows it. It stops early when the
 * incident settles (every VM's run ended), so a press never runs past the moment things went
 * quiet. Caps are safety limits in ticks, not durations; the wall-clock budget keeps the page
 * responsive.
 */
import { nextStepTick } from '../../domain/steps';
import type { Simulation } from '../../engine/types';
import type { StepTracker } from './step-tracker';

export interface PressCaps {
  /** Ticks to wait for the first change when something is stalled or recovering. */
  readonly active: number;
  /** Ticks a press may run in total. */
  readonly max: number;
  /** Ticks a press runs when nothing is happening. */
  readonly quiet: number;
  /** Wall-clock budget, ms (`now` is injectable for tests). */
  readonly budgetMs: number;
  readonly now?: () => number;
}

/** Tick at which the counter of any open run next advances (null: no run is open). */
function nextBoundary(steps: StepTracker, t: number): number | null {
  let at: number | null = null;
  for (const v of steps.view().vms.values()) {
    if (v.startT === null || v.endT !== null) continue;
    const n = nextStepTick(v, t);
    if (n !== null) at = at === null ? n : Math.min(at, n);
  }
  return at;
}

/** Something is stalled or still moving (a powered-off spare is not activity). */
function isActive(steps: StepTracker): boolean {
  return [...steps.view().samples.values()].some((list) => {
    const last = list[list.length - 1];
    return (
      last !== undefined &&
      ((last.state !== 'running' && last.state !== 'off') || last.ioPendingS > 0)
    );
  });
}

export function pressStep(
  sim: Pick<Simulation, 'tick' | 'getSnapshot'>,
  steps: StepTracker,
  caps: PressCaps,
): void {
  const clock = caps.now ?? (() => performance.now());
  const deadline = clock() + caps.budgetMs;
  const before = steps.view().current;
  const t0 = sim.getSnapshot().simTime;
  const first = nextBoundary(steps, t0);
  // An open run (stalled, or redirected and waiting for its failback) is waited out to its next
  // step; without one, a stall may be starting (wait a while) or nothing is happening.
  const wait =
    first !== null
      ? Math.min(caps.max, Math.max(caps.active, first - t0 + 1))
      : isActive(steps)
        ? caps.active
        : caps.quiet;
  let ticks = 0;
  // 1. Into the next step.
  while (ticks < wait && clock() <= deadline) {
    sim.tick(1);
    ticks++;
    if (steps.view().current !== before) break;
  }
  if (steps.view().current === before) return;
  // 2. Through it: stop on the last tick of this step, or when the incident settles.
  while (ticks < caps.max && clock() <= deadline) {
    const t = sim.getSnapshot().simTime;
    const next = nextBoundary(steps, t);
    if (next === null || t + 1 >= next) return;
    sim.tick(1);
    ticks++;
  }
}
