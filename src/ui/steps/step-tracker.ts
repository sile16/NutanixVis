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
import {
  deriveVmSteps,
  stepAt,
  type VmSample,
  type VmSteps,
  vmSampleState,
} from '../../domain/steps';
import type { SimEvent, Simulation, Snapshot } from '../../engine/types';

/**
 * How far one press of Step runs when nothing is happening (no interruption, every VM running):
 * a pacing unit for the button, not a statement about real time. The counter itself comes from
 * the relative step scale (`src/domain/steps/scale.ts`), not from this.
 */
export const STEP_IDLE_PRESS_TICKS = 30;

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
  /** Highest step reached by any VM in the current incident (0 before any interruption). */
  readonly current: number;
  /** Every VM's run in the current incident has ended (or nothing stalled). */
  readonly settled: boolean;
  /** Step reached by simulation tick `t` (events and traces are placed with it). */
  stepOfTick(t: number): number;
}

export class StepTracker {
  private readonly samples = new Map<string, StepSample[]>();
  private cache: { key: string; view: StepsView } | null = null;
  private lastTick = -1;
  /** Highest step shown so far: the counter never goes backwards while a run is in progress. */
  private peak = 0;
  /** First tick of the current incident; earlier samples belong to past incidents. */
  private incidentFrom = 0;
  private readonly past: { from: number; vms: ReadonlyMap<string, VmSteps> }[] = [];

  constructor(private readonly source: Pick<Simulation, 'getSnapshot' | 'subscribe' | 'eventLog'>) {
    this.record(source.getSnapshot());
    source.subscribe(() => this.record(source.getSnapshot()));
  }

  record(s: Snapshot): void {
    if (s.simTime < this.lastTick) {
      this.samples.clear();
      this.peak = 0;
      this.incidentFrom = 0;
      this.past.length = 0;
    }
    this.lastTick = s.simTime;
    for (const d of Object.values(s.devices)) {
      if (d.kind !== 'vm') continue;
      const f = d.fields;
      const sample: StepSample = {
        t: s.simTime,
        state: vmSampleState(d.status, f.state),
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

  /**
   * Start a new incident if the current one has settled (every VM's run ended, or nothing ever
   * stalled): the counter restarts from 0 for whatever happens from tick `t` on. Called when the
   * user applies an action; a new interruption after a settled incident also starts one.
   */
  beginIncidentIfSettled(t: number): void {
    const v = this.view();
    if (!v.settled || this.incidentFrom === t) return;
    this.past.push({ from: this.incidentFrom, vms: v.vms });
    this.incidentFrom = t;
    this.peak = 0;
    this.cache = null;
  }

  view(): StepsView {
    const events: readonly SimEvent[] = this.source.eventLog();
    const key = `${this.lastTick}:${events.length}:${this.source.getSnapshot().version}:${this.incidentFrom}`;
    if (this.cache?.key === key) return this.cache.view;
    let vms = this.derive(events, this.incidentFrom);
    // A settled incident followed by a new interruption: that interruption opens a new incident.
    const settledAt = settledTick(vms, this.incidentFrom);
    if (settledAt !== null && settledAt < this.lastTick) {
      const next = this.derive(events, settledAt + 1);
      if ([...next.values()].some((s) => s.startT !== null)) {
        this.past.push({ from: this.incidentFrom, vms });
        this.incidentFrom = settledAt + 1;
        this.peak = 0;
        vms = next;
      }
    }
    const from = this.incidentFrom;
    const past = [...this.past];
    const stepOfTick = (t: number): number => {
      const inc = t >= from ? { vms } : [...past].reverse().find((p) => t >= p.from);
      let n = 0;
      for (const s of inc?.vms.values() ?? []) n = Math.max(n, stepAt(s, t));
      return n;
    };
    this.peak = Math.max(this.peak, stepOfTick(this.lastTick));
    const view: StepsView = {
      vms,
      samples: this.samples,
      current: this.peak,
      settled: settledTick(vms, this.incidentFrom) !== null,
      stepOfTick,
    };
    this.cache = { key, view };
    return view;
  }

  private derive(events: readonly SimEvent[], from: number): Map<string, VmSteps> {
    const vms = new Map<string, VmSteps>();
    for (const [id, series] of this.samples) {
      const part = from <= 0 ? series : series.filter((x) => x.t >= from);
      vms.set(id, deriveVmSteps(id, events, part as readonly VmSample[]));
    }
    return vms;
  }
}

/**
 * Tick at which every VM's run in the incident starting at `from` had ended (`from` when nothing
 * stalled), or null while one is open.
 */
function settledTick(vms: ReadonlyMap<string, VmSteps>, from: number): number | null {
  let at = from;
  for (const s of vms.values()) {
    if (s.startT === null) continue;
    if (s.endT === null) return null;
    at = Math.max(at, s.endT);
  }
  return at;
}
