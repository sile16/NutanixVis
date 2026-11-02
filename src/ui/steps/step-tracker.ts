/**
 * Steps view of a run (UI-only, no React). Time is shown as STEPS: an ordinal on a relative scale
 * (no interruption, brief, longer, redirected later, recovered), never as seconds. The ordinals
 * come from the domain's headless derivation (`src/domain/steps`); this class only feeds it: it
 * subscribes to the simulation, keeps one sample per VM per tick, and derives each VM's steps from
 * the event log. Nothing here is fed back into the simulation.
 *
 * The global step is the highest step any VM's interruption has reached. It stays 0 while nothing
 * stalls, which is what "no interruption" (for example a bond that moved traffic) looks like.
 */
import { deriveVmSteps, stepAt, type VmSample, type VmSteps } from '../../domain/steps';
import type { SimEvent, Simulation, Snapshot } from '../../engine/types';

/**
 * One quantum step: the number of engine ticks that make one step once no derived stage is
 * pending (every VM running, no IO queued). It is a pacing unit for the counter, not a statement
 * about real time. Defined here and nowhere else.
 */
export const STEP_QUANTUM_TICKS = 75;

export interface StepSample {
  readonly t: number;
  readonly state: string;
  readonly ioPendingS: number;
  readonly host: string | null;
  readonly ownerCvm: string | null;
}

export interface StepsView {
  readonly vms: ReadonlyMap<string, VmSteps>;
  readonly samples: ReadonlyMap<string, readonly StepSample[]>;
  /** Highest step reached by any VM so far (0 before any interruption). */
  readonly current: number;
  /** Step reached by simulation tick `t` (events and traces are placed with it). */
  stepOfTick(t: number): number;
}

export class StepTracker {
  private readonly samples = new Map<string, StepSample[]>();
  private cache: { key: string; view: StepsView } | null = null;
  private lastTick = -1;
  /** Highest step shown so far: the counter never goes backwards while a run is in progress. */
  private peak = 0;
  /** Ticks at which a quantum step completed (quiet system, no derived stage reached). */
  private marks: number[] = [];
  /** Tick of the last step boundary (a derived stage or a quantum mark) and the derived peak then. */
  private boundary = 0;
  private derivedPeak = 0;

  constructor(private readonly source: Pick<Simulation, 'getSnapshot' | 'subscribe' | 'eventLog'>) {
    this.record(source.getSnapshot());
    source.subscribe(() => this.record(source.getSnapshot()));
  }

  record(s: Snapshot): void {
    if (s.simTime < this.lastTick) {
      this.samples.clear();
      this.peak = 0;
      this.marks = [];
      this.boundary = 0;
      this.derivedPeak = 0;
    }
    this.lastTick = s.simTime;
    for (const d of Object.values(s.devices)) {
      if (d.kind !== 'vm') continue;
      const f = d.fields;
      const sample: StepSample = {
        t: s.simTime,
        state: String(f.state),
        ioPendingS: typeof f.ioPendingS === 'number' ? f.ioPendingS : 0,
        host: typeof f.host === 'string' ? f.host : null,
        ownerCvm: typeof f.ownerCvm === 'string' ? f.ownerCvm : null,
      };
      const list = this.samples.get(d.id) ?? [];
      const last = list[list.length - 1];
      // An action queued at the same tick replaces that tick's sample.
      if (last && last.t === sample.t) list[list.length - 1] = sample;
      else list.push(sample);
      this.samples.set(d.id, list);
    }
    this.markQuantum();
    this.cache = null;
  }

  /**
   * Past the last derived stage the counter keeps going: once the system is quiet and a quantum
   * of ticks passed with no derived stage reached, that is one more step. Nothing counts before
   * the first interruption (the counter reads 0 while steady).
   */
  private markQuantum(): void {
    const quiet = [...this.samples.values()].every((list) => {
      const last = list[list.length - 1];
      return last === undefined || (last.state === 'running' && last.ioPendingS <= 0);
    });
    if (!quiet || this.lastTick - this.boundary < STEP_QUANTUM_TICKS) return;
    if (this.failedBack()) return;
    const derived = this.derivedAt(this.lastTick);
    if (derived > this.derivedPeak) {
      this.derivedPeak = derived;
      this.boundary = this.lastTick;
    } else if (this.derivedPeak > 0) {
      this.marks.push(this.lastTick);
      this.boundary = this.lastTick;
    }
  }

  /** The sessions have failed back to the local CVM: the run is over, the counter stops. */
  private failedBack(): boolean {
    const events = this.source.eventLog();
    for (const [id, series] of this.samples) {
      const v = deriveVmSteps(id, events, series as readonly VmSample[]);
      if (v.milestones.some((m) => m.stage === 'failed-back' && m.t <= this.lastTick)) return true;
    }
    return false;
  }

  private derivedAt(t: number): number {
    const events = this.source.eventLog();
    let n = 0;
    for (const [id, series] of this.samples)
      n = Math.max(n, stepAt(deriveVmSteps(id, events, series as readonly VmSample[]), t));
    return n;
  }

  view(): StepsView {
    const events: readonly SimEvent[] = this.source.eventLog();
    const key = `${this.lastTick}:${this.marks.length}:${events.length}:${this.source.getSnapshot().version}`;
    if (this.cache?.key === key) return this.cache.view;
    const vms = new Map<string, VmSteps>();
    for (const [id, series] of this.samples)
      vms.set(id, deriveVmSteps(id, events, series as readonly VmSample[]));
    const stepOfTick = (t: number): number => {
      let n = 0;
      for (const v of vms.values()) n = Math.max(n, stepAt(v, t));
      // Quantum steps taken by tick `t` shift every later derived stage, so the counter is
      // monotonic and events, cells and the counter agree.
      let extra = 0;
      for (const m of this.marks) if (m <= t) extra++;
      return n + extra;
    };
    this.peak = Math.max(this.peak, stepOfTick(this.lastTick));
    const view: StepsView = {
      vms,
      samples: this.samples,
      current: this.peak,
      stepOfTick,
    };
    this.cache = { key, view };
    return view;
  }
}
