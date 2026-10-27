/**
 * Simulated clock and timers (SPEC §5.1). 1 tick = 1 simulated second. Timers are declared in
 * seconds and fire during the tick phase (SPEC §5.2 phase 5) of tick `now + seconds`.
 * Ordering is deterministic: by due time, then by creation order.
 */
import type { SimTime, TimerApi, TimerHandle, TimerOptions } from './types';

/** Owner of engine-internal timers (e.g. LACP detection) that belong to no caller device. */
export const ENGINE_OWNER = '@engine';

interface TimerRecord {
  readonly handle: TimerHandle;
  readonly owner: string;
  readonly seq: number;
  readonly opts: TimerOptions;
  readonly onFire: () => void;
}

export interface PendingTimer extends TimerHandle {
  readonly owner: string;
  readonly cite: readonly string[];
}

export class TimerQueue {
  private seq = 0;
  private readonly records = new Map<string, TimerRecord>();

  constructor(private readonly clock: () => SimTime) {}

  /** Schedule `onFire` at `now + ceil(seconds)`. Throws unless `seconds >= 1`. */
  set(
    owner: string,
    name: string,
    seconds: number,
    opts: TimerOptions,
    onFire: () => void,
  ): TimerHandle {
    if (!Number.isFinite(seconds) || seconds < 1) {
      throw new RangeError(`timer '${name}': seconds must be >= 1, got ${seconds}`);
    }
    const seq = ++this.seq;
    const handle: TimerHandle = Object.freeze({
      id: `t${seq}`,
      name,
      dueAt: this.clock() + Math.ceil(seconds),
    });
    this.records.set(handle.id, { handle, owner, seq, opts, onFire });
    return handle;
  }

  cancel(handle: TimerHandle | string): void {
    this.records.delete(typeof handle === 'string' ? handle : handle.id);
  }

  /** Cancel every timer whose owner matches (used when a device goes down). */
  cancelWhere(match: (owner: string) => boolean): number {
    let n = 0;
    for (const [id, r] of this.records) {
      if (match(r.owner)) {
        this.records.delete(id);
        n++;
      }
    }
    return n;
  }

  has(handle: TimerHandle | string): boolean {
    return this.records.has(typeof handle === 'string' ? handle : handle.id);
  }

  /** Pending timers in firing order, optionally only those of one owner. */
  pending(owner?: string): readonly PendingTimer[] {
    return this.sorted()
      .filter((r) => owner === undefined || r.owner === owner)
      .map((r) => ({ ...r.handle, owner: r.owner, cite: r.opts.cite }));
  }

  /** Soonest due time, or `null` when nothing is pending. */
  nextDueAt(): SimTime | null {
    let min: SimTime | null = null;
    for (const r of this.records.values()) {
      if (min === null || r.handle.dueAt < min) min = r.handle.dueAt;
    }
    return min;
  }

  /**
   * Fire every timer due at or before `now`, in (dueAt, creation) order. A callback may cancel
   * later timers; new timers are always due in the future (seconds >= 1), so they never fire in
   * the same pass. Returns the handles fired.
   */
  fireDue(now: SimTime): readonly TimerHandle[] {
    const due = this.sorted().filter((r) => r.handle.dueAt <= now);
    const fired: TimerHandle[] = [];
    for (const r of due) {
      if (!this.records.delete(r.handle.id)) continue;
      fired.push(r.handle);
      r.onFire();
    }
    return fired;
  }

  /** A `TimerApi` scoped to one owner: `pending()` lists only that owner's timers. */
  api(owner: string): TimerApi {
    return {
      set: (name, seconds, opts, onFire) => this.set(owner, name, seconds, opts, onFire),
      cancel: (handle) => this.cancel(handle),
      pending: () => this.pending(owner).map(({ id, name, dueAt }) => ({ id, name, dueAt })),
    };
  }

  private sorted(): TimerRecord[] {
    return [...this.records.values()].sort(
      (a, b) => a.handle.dueAt - b.handle.dueAt || a.seq - b.seq,
    );
  }
}
