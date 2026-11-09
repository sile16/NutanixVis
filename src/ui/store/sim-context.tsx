/**
 * Engine bridge (SPEC §3): the UI reads frozen snapshots through `useSyncExternalStore` and only
 * changes the simulation through `applyAction` / `tick` / `runUntilNextTimer`.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import type { ActionRequest, Simulation, Snapshot } from '../../engine/types';
import { PressRunner, StepPress } from '../steps/step-press';
import { STEP_IDLE_PRESS_TICKS, type StepsView, StepTracker } from '../steps/step-tracker';
import { SnapshotHistory } from './snapshot-history';
import { useUi } from './ui-store';

interface SimBundle {
  readonly sim: Simulation;
  /** Every tick's snapshot (recorded outside React, so batched playback loses none). */
  readonly history: SnapshotHistory;
  /** Steps view: per-VM interruption steps derived from the run (see `steps/step-tracker.ts`). */
  readonly steps: StepTracker;
  /** Runs Step presses in slices across animation frames (`steps/step-press.ts`). */
  readonly press: PressRunner;
}

/**
 * Safety caps for `stepForward` (ticks), not durations: a press runs through the next step
 * (`steps/step-press.ts`). Later steps are longer (the scale doubles), so a press always runs to
 * the end of its step, in slices across animation frames; STEP_CAP_MAX is only a safety limit,
 * well above the longest step shown (step 13 ends 40 960 ticks after the interruption began).
 */
const STEP_CAP_ACTIVE = 900;
const STEP_CAP_MAX = 60_000;
const STEP_CAP_QUIET = STEP_IDLE_PRESS_TICKS + 2;
/** Wall-clock slices of a press, ms: in the click handler, then per animation frame. */
const STEP_SYNC_MS = 50;
const STEP_FRAME_MS = 14;

const SimContext = createContext<SimBundle | null>(null);

export function SimProvider({ sim, children }: { sim: Simulation; children: ReactNode }) {
  // One history per simulation: a reset or topology switch starts an empty one.
  const value = useMemo(
    () => ({
      sim,
      history: new SnapshotHistory(sim),
      steps: new StepTracker(sim),
      press: new PressRunner({ syncMs: STEP_SYNC_MS, frameMs: STEP_FRAME_MS }),
    }),
    [sim],
  );
  // A reset or topology switch stops a press still running on the old simulation.
  useEffect(() => () => value.press.cancel(), [value]);
  // Dev builds only: expose the live simulation for debugging from the console.
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    (window as unknown as { __nvSim?: Simulation }).__nvSim = sim;
  }
  return <SimContext.Provider value={value}>{children}</SimContext.Provider>;
}

function useBundle(): SimBundle {
  const b = useContext(SimContext);
  if (!b) throw new Error('useSim must be used inside <SimProvider>');
  return b;
}

export function useSim(): Simulation {
  return useBundle().sim;
}

export function useSnapshotHistory(): SnapshotHistory {
  return useBundle().history;
}

export function useSnapshot(): Snapshot {
  const sim = useSim();
  const subscribe = useCallback((listener: () => void) => sim.subscribe(listener), [sim]);
  const get = useCallback(() => sim.getSnapshot(), [sim]);
  return useSyncExternalStore(subscribe, get, get);
}

/** The run so far as steps (re-reads on every snapshot). */
export function useSteps(): StepsView {
  const bundle = useBundle();
  useSnapshot();
  return bundle.steps.view();
}

/** A Step press is running (the button shows it is busy and ignores presses). */
export function useStepBusy(): boolean {
  const { press } = useBundle();
  return useSyncExternalStore(
    press.subscribe,
    () => press.busy,
    () => press.busy,
  );
}

/** Time and action controls. In auto mode an action applied while paused ticks immediately. */
export function useSimControls() {
  const { sim, steps, press } = useBundle();
  const noteTicked = useUi((s) => s.noteTicked);
  const noteActionQueued = useUi((s) => s.noteActionQueued);

  const step = useCallback(
    (n = 1) => {
      sim.tick(n);
      noteTicked();
    },
    [sim, noteTicked],
  );
  /**
   * Advance to the next step: run until some run of the incident reaches a new step, then to the
   * end of that step. Quiet systems (nothing stalled or redirected, or waiting for recovery) only
   * move a few ticks. A long step runs across animation frames; a press while one is running is
   * ignored, and starting playback stops it.
   */
  const stepForward = useCallback(() => {
    if (press.busy) return;
    const p = new StepPress(sim, steps, {
      active: STEP_CAP_ACTIVE,
      max: STEP_CAP_MAX,
      quiet: STEP_CAP_QUIET,
    });
    press.start(p, noteTicked, () => useUi.getState().playing);
  }, [sim, steps, press, noteTicked]);
  const fastForward = useCallback(() => {
    sim.runUntilNextTimer();
    noteTicked();
  }, [sim, noteTicked]);
  const apply = useCallback(
    (action: ActionRequest) => {
      // A new action stops a Step press still running, so it does not run on past it.
      press.cancel();
      // A new action after everything settled starts a new incident: the counter restarts at 0.
      steps.beginIncidentIfSettled(sim.getSnapshot().simTime);
      sim.applyAction(action);
      noteActionQueued();
      const { manual, playing } = useUi.getState();
      if (!manual && !playing) step();
    },
    [sim, steps, press, noteActionQueued, step],
  );
  return { step, stepForward, fastForward, apply };
}
