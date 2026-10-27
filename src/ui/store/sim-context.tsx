/**
 * Engine bridge (SPEC §3): the UI reads frozen snapshots through `useSyncExternalStore` and only
 * changes the simulation through `applyAction` / `tick` / `runUntilNextTimer`.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';
import type { ActionRequest, Simulation, Snapshot } from '../../engine/types';
import { SnapshotHistory } from './snapshot-history';
import { useUi } from './ui-store';

interface SimBundle {
  readonly sim: Simulation;
  /** Every tick's snapshot (recorded outside React, so batched playback loses none). */
  readonly history: SnapshotHistory;
}

const SimContext = createContext<SimBundle | null>(null);

export function SimProvider({ sim, children }: { sim: Simulation; children: ReactNode }) {
  // One history per simulation: a reset or topology switch starts an empty one.
  const value = useMemo(() => ({ sim, history: new SnapshotHistory(sim) }), [sim]);
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

/** Time and action controls. In auto mode an action applied while paused ticks immediately. */
export function useSimControls() {
  const sim = useSim();
  const noteTicked = useUi((s) => s.noteTicked);
  const noteActionQueued = useUi((s) => s.noteActionQueued);

  const step = useCallback(
    (n = 1) => {
      sim.tick(n);
      noteTicked();
    },
    [sim, noteTicked],
  );
  const fastForward = useCallback(() => {
    sim.runUntilNextTimer();
    noteTicked();
  }, [sim, noteTicked]);
  const apply = useCallback(
    (action: ActionRequest) => {
      sim.applyAction(action);
      noteActionQueued();
      const { manual, playing } = useUi.getState();
      if (!manual && !playing) step();
    },
    [sim, noteActionQueued, step],
  );
  return { step, fastForward, apply };
}
