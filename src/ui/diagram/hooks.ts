import { useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot, Trace } from '../../engine/types';
import { type ActivityWindow, buildActivityWindow } from './activity-window';

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

/** The last `depth` ticks' traces (newest first), for the link hover card. */
export function useTraceHistory(snapshot: Snapshot, depth = 3): readonly TraceHistoryEntry[] {
  const ref = useRef<{ topology: string; entries: TraceHistoryEntry[] }>({
    topology: snapshot.topologyId,
    entries: [],
  });
  const cur = ref.current;
  if (cur.topology !== snapshot.topologyId) {
    cur.topology = snapshot.topologyId;
    cur.entries = [];
  }
  if (cur.entries[0]?.version !== snapshot.version) {
    cur.entries = [
      { version: snapshot.version, simTime: snapshot.simTime, traces: snapshot.traces },
      ...cur.entries.filter((e) => e.version < snapshot.version),
    ].slice(0, depth);
  }
  return cur.entries;
}

/**
 * Rolling window of the last `ticks` snapshots (oldest first), for flicker-free activity views.
 * Resets on a new topology or when time goes backwards (a new simulation).
 */
export function useActivityWindow(snapshot: Snapshot, ticks: number): ActivityWindow {
  const ref = useRef<Snapshot[]>([]);
  return useMemo(() => {
    const buf = ref.current;
    const last = buf[buf.length - 1];
    if (last && (last.topologyId !== snapshot.topologyId || snapshot.simTime < last.simTime)) {
      buf.length = 0;
    }
    const tail = buf[buf.length - 1];
    if (tail && tail.simTime === snapshot.simTime) buf[buf.length - 1] = snapshot;
    else buf.push(snapshot);
    while (buf.length > Math.max(1, ticks)) buf.shift();
    return buildActivityWindow(buf);
  }, [snapshot, ticks]);
}
