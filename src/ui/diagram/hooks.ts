import { useEffect, useMemo, useState } from 'react';
import type { Snapshot, Trace } from '../../engine/types';
import { useSnapshot, useSnapshotHistory } from '../store/sim-context';
import { useUi } from '../store/ui-store';
import { type ActivityWindow, buildActivityWindow } from './activity-window';
import { isCategoryVisible } from './traffic';

export function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

export interface TraceHistoryEntry {
  readonly version: number;
  readonly simTime: number;
  readonly traces: readonly Trace[];
}

/**
 * The last `depth` ticks' traces (newest first), for the link hover card. Read from the shared
 * snapshot history, so batched playback (×20, ×60) does not skip ticks; hidden traffic
 * categories (legend filter) are left out.
 */
export function useTraceHistory(depth = 3): readonly TraceHistoryEntry[] {
  const snapshot = useSnapshot();
  const history = useSnapshotHistory();
  const traffic = useUi((s) => s.traffic);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the history grows per snapshot
  return useMemo(
    () =>
      history
        .last(depth)
        .map((s) => ({
          version: s.version,
          simTime: s.simTime,
          traces: s.traces.filter((t) => isCategoryVisible(traffic, t.category)),
        }))
        .reverse(),
    [history, snapshot, depth, traffic],
  );
}

/**
 * Rolling window of the last `ticks` ticks (oldest first), for flicker-free activity views. Every
 * view (diagram, inspector) reads the same per-simulation history, so they always agree, and a
 * new simulation (reset, topology or version switch) starts empty.
 */
export function useActivityWindow(ticks: number): ActivityWindow {
  const snapshot = useSnapshot();
  const history = useSnapshotHistory();
  const traffic = useUi((s) => s.traffic);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the history grows per snapshot
  return useMemo(
    () => buildActivityWindow(history.last(ticks), (c) => isCategoryVisible(traffic, c)),
    [history, snapshot, ticks, traffic],
  );
}

/** The snapshot just before the current one (for "new this tick" checks), if any. */
export function usePreviousSnapshot(): Snapshot | undefined {
  const snapshot = useSnapshot();
  const history = useSnapshotHistory();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the history grows per snapshot
  return useMemo(() => {
    const last = history.last(2);
    return last.length === 2 ? last[0] : undefined;
  }, [history, snapshot]);
}
