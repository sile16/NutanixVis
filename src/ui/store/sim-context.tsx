/**
 * Engine bridge (SPEC §3): the UI reads frozen snapshots through `useSyncExternalStore` and only
 * changes the simulation through `applyAction` / `tick` / `runUntilNextTimer`.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useSyncExternalStore,
} from 'react';
import type { ActionRequest, Simulation, Snapshot } from '../../engine/types';
import { useUi } from './ui-store';

const SimContext = createContext<Simulation | null>(null);

export function SimProvider({ sim, children }: { sim: Simulation; children: ReactNode }) {
  return <SimContext.Provider value={sim}>{children}</SimContext.Provider>;
}

export function useSim(): Simulation {
  const sim = useContext(SimContext);
  if (!sim) throw new Error('useSim must be used inside <SimProvider>');
  return sim;
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
