/**
 * Snapshot history (UI-only, no React). Subscribes to a `Simulation` directly and keeps every
 * tick's snapshot, so the activity window covers real ticks even when playback batches several
 * ticks per render (×20 / ×60 run 4–12 ticks per interval and React only renders the last one).
 *
 * One history per simulation: a reset or topology switch builds a new simulation and therefore a
 * new, empty history, so no activity leaks across runs.
 */
import type { Simulation, Snapshot } from '../../engine/types';

/** Longest window the UI offers (header "Activity" select). */
export const MAX_HISTORY_TICKS = 30;

export class SnapshotHistory {
  private buf: Snapshot[] = [];

  constructor(
    source: Pick<Simulation, 'getSnapshot' | 'subscribe'>,
    private readonly max = MAX_HISTORY_TICKS,
  ) {
    this.record(source.getSnapshot());
    source.subscribe(() => this.record(source.getSnapshot()));
  }

  /** Add a snapshot; a newer version at the same simTime (e.g. an action queued) replaces it. */
  record(s: Snapshot): void {
    const last = this.buf[this.buf.length - 1];
    if (last === s) return;
    if (last && (last.topologyId !== s.topologyId || s.simTime < last.simTime)) this.buf = [];
    const tail = this.buf[this.buf.length - 1];
    if (tail && tail.simTime === s.simTime) this.buf[this.buf.length - 1] = s;
    else this.buf.push(s);
    if (this.buf.length > this.max) this.buf.splice(0, this.buf.length - this.max);
  }

  /** The last `ticks` snapshots, oldest first (at least the current one). */
  last(ticks: number): readonly Snapshot[] {
    return this.buf.slice(-Math.max(1, Math.min(ticks, this.max)));
  }
}
