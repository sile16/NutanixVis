/**
 * One press of the Step button (UI-only, headless so it can be tested). A press runs through the
 * NEXT step of the current incident: it ticks until the counter moves to a new step, then keeps
 * going to the end of that step, so everything that happened in it (a maintenance entry, a
 * redirect, the IO resuming) is on screen when the counter shows it. It stops early when the
 * incident settles (every run ended), or when every open run starts waiting on the user, so a
 * press never runs past the moment things went quiet. While the counter waits for recovery a
 * press only moves a few ticks.
 *
 * Later steps are long (the scale doubles), so a press is a resumable `StepPress`: `pressStep`
 * runs it to the end at once (tests), and `PressRunner` runs it in chunks across animation frames
 * so the page stays responsive. Caps are safety limits in ticks, not durations.
 */
import { nextStepTick } from '../../domain/steps';
import type { Simulation } from '../../engine/types';
import type { StepsView, StepTracker } from './step-tracker';

export interface PressCaps {
  /** Ticks to wait for the first change when something is stalled or recovering. */
  readonly active: number;
  /** Ticks a press may run in total (a hard safety cap, well above the longest step shown). */
  readonly max: number;
  /** Ticks a press runs when nothing is happening (or the counter waits for recovery). */
  readonly quiet: number;
}

/** Tick at which the counter of any open, counting run next advances (null: none). */
function nextBoundary(view: StepsView, t: number): number | null {
  let at: number | null = null;
  for (const v of view.runs) {
    if (v.startT === null || v.endT !== null) continue;
    const n = nextStepTick(v, t);
    if (n !== null) at = at === null ? n : Math.min(at, n);
  }
  return at;
}

/** Something is stalled or still moving (a powered-off VM is not activity). */
function isActive(view: StepsView): boolean {
  return [...view.samples.values()].some((list) => {
    const last = list[list.length - 1];
    return (
      last !== undefined &&
      ((last.state !== 'running' && last.state !== 'off') || last.ioPendingS > 0)
    );
  });
}

/** One press, advanced in slices (`advance`) until `done`. */
export class StepPress {
  private ticks = 0;
  private phase: 'into' | 'through' | 'done' = 'into';
  private readonly before: number;
  private readonly wait: number;
  private readonly wasSettled: boolean;
  private readonly wasWaiting: boolean;

  constructor(
    private readonly sim: Pick<Simulation, 'tick' | 'getSnapshot'>,
    private readonly steps: StepTracker,
    private readonly caps: PressCaps,
  ) {
    const v = steps.view();
    const t0 = sim.getSnapshot().simTime;
    this.before = v.current;
    this.wasSettled = v.settled;
    this.wasWaiting = v.waiting;
    const first = nextBoundary(v, t0);
    // An open run (stalled, or redirected and waiting for its failback) is waited out to its next
    // step; a run waiting on the user, or nothing at all, gets a short press; otherwise a stall
    // may be starting (wait a while).
    this.wait =
      first !== null
        ? Math.min(caps.max, Math.max(caps.active, first - t0 + 1))
        : !v.waiting && isActive(v)
          ? caps.active
          : caps.quiet;
  }

  get done(): boolean {
    return this.phase === 'done';
  }

  /** Ticks run so far. */
  get ticked(): number {
    return this.ticks;
  }

  /** Run at most `budget` more ticks; true once the press is complete. */
  advance(budget: number): boolean {
    let n = 0;
    while (this.phase !== 'done' && n < budget) {
      if (this.phase === 'into') {
        // 1. Into the next step (or until the incident settles or starts waiting on the user).
        if (this.ticks >= this.wait) {
          this.phase = 'done';
          break;
        }
        this.sim.tick(1);
        this.ticks++;
        n++;
        const v = this.steps.view();
        if (v.current !== this.before) this.phase = 'through';
        else if ((!this.wasSettled && v.settled) || (!this.wasWaiting && v.waiting)) {
          this.phase = 'done';
        }
      } else {
        // 2. Through it: stop on the last tick of this step, or when no run is counting.
        const t = this.sim.getSnapshot().simTime;
        const next = nextBoundary(this.steps.view(), t);
        if (this.ticks >= this.caps.max || next === null || t + 1 >= next) {
          this.phase = 'done';
          break;
        }
        this.sim.tick(1);
        this.ticks++;
        n++;
      }
    }
    return this.phase === 'done';
  }
}

/** Run one press to the end at once (headless: tests and scripts). */
export function pressStep(
  sim: Pick<Simulation, 'tick' | 'getSnapshot'>,
  steps: StepTracker,
  caps: PressCaps,
): void {
  const press = new StepPress(sim, steps, caps);
  while (!press.advance(Number.POSITIVE_INFINITY));
}

export interface RunnerOptions {
  /** Wall-clock slice run straight away in the click handler, ms (short presses end there). */
  readonly syncMs: number;
  /** Wall-clock slice per animation frame after that, ms. */
  readonly frameMs: number;
  readonly now?: () => number;
  readonly schedule?: (cb: () => void) => void;
}

/**
 * Runs presses in wall-clock slices across animation frames (one at a time: a press while one is
 * running is ignored). `busy` and `subscribe` let the Step button show it is working.
 */
export class PressRunner {
  private active: StepPress | null = null;
  private token = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly opts: RunnerOptions) {}

  get busy(): boolean {
    return this.active !== null;
  }

  readonly subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /**
   * Start `press` unless one is running (returns false then). `onProgress` runs after each slice
   * and at the end; `stop` is checked before each frame (for example: playback started).
   */
  start(press: StepPress, onProgress: () => void, stop: () => boolean = () => false): boolean {
    if (this.active !== null) return false;
    const now = this.opts.now ?? (() => performance.now());
    const schedule = this.opts.schedule ?? ((cb: () => void) => requestAnimationFrame(cb));
    const token = ++this.token;
    const slice = (ms: number): boolean => {
      const until = now() + ms;
      do {
        if (press.advance(8)) return true;
      } while (now() < until);
      return false;
    };
    const finish = (): void => {
      this.active = null;
      onProgress();
      this.emit();
    };
    if (slice(this.opts.syncMs)) {
      onProgress();
      return true;
    }
    this.active = press;
    this.emit();
    const frame = (): void => {
      if (token !== this.token) return;
      if (stop() || slice(this.opts.frameMs)) finish();
      else {
        onProgress();
        schedule(frame);
      }
    };
    onProgress();
    schedule(frame);
    return true;
  }

  /** Stop the running press where it is (a reset, a new action). */
  cancel(): void {
    if (this.active === null) return;
    this.token++;
    this.active = null;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
