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

  constructor(private readonly source: Pick<Simulation, 'getSnapshot' | 'subscribe' | 'eventLog'>) {
    this.record(source.getSnapshot());
    source.subscribe(() => this.record(source.getSnapshot()));
  }

  record(s: Snapshot): void {
    if (s.simTime < this.lastTick) {
      this.samples.clear();
      this.peak = 0;
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
    this.cache = null;
  }

  view(): StepsView {
    const events: readonly SimEvent[] = this.source.eventLog();
    const key = `${this.lastTick}:${events.length}:${this.source.getSnapshot().version}`;
    if (this.cache?.key === key) return this.cache.view;
    const vms = new Map<string, VmSteps>();
    for (const [id, series] of this.samples)
      vms.set(id, deriveVmSteps(id, events, series as readonly VmSample[]));
    const stepOfTick = (t: number): number => {
      let n = 0;
      for (const v of vms.values()) n = Math.max(n, stepAt(v, t));
      return n;
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
