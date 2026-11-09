/**
 * Steps view of a run (UI-only, no React). Time is shown as STEPS: an ordinal on a relative scale
 * (no interruption, brief, longer, redirected later, recovered), never as seconds. The ordinals
 * come from the domain's headless derivation (`src/domain/steps`); this class only feeds it: it
 * subscribes to the simulation, keeps one sample per VM per tick, and derives each VM's runs from
 * the event log. Nothing here is fed back into the simulation.
 *
 * An incident is every run (each VM interruption, each planned array operation) from the first
 * one until all of them have ended. The global step is the highest step any of its runs has
 * reached. It stays 0 while nothing stalls, which is what "no interruption" (for example a bond
 * that moved traffic) looks like. A planned array operation (a controller reboot, an NDU) is a run
 * of its own: the counter climbs through its drain, reboot and return although no VM stalls. A VM
 * interrupted again while the incident is open adds a run; the incident stays open until it ends,
 * and the counter keeps its value (it never restarts at 1 inside an incident). While every open
 * run waits on the user (`isWaiting`: a fault not recovered), the counter stops: "waiting for
 * recovery".
 */
import {
  type ArrayOpSteps,
  countsAt,
  deriveArrayOps,
  EventIndex,
  faultWindows,
  finishRuns,
  isWaiting,
  RunScanner,
  type RunSpan,
  stepAt,
  summarizeVmRuns,
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
  /** Share of the guest's IO stalled, % (the VM's `stuckIoPct`). */
  readonly stuckPct?: number | undefined;
}

export interface StepsView {
  /** Each VM's interruptions in the current incident, summarized (display only). */
  readonly vms: ReadonlyMap<string, VmSteps>;
  /** The latest planned array operation of the current incident (startT null: none). */
  readonly array: ArrayOpSteps;
  /** Every run of the current incident: each VM interruption, each array operation. */
  readonly runs: readonly RunSpan[];
  readonly samples: ReadonlyMap<string, readonly StepSample[]>;
  /** First tick of the current incident (internal). */
  readonly from: number;
  /** Highest step reached by any run in the current incident (0 before any interruption). */
  readonly current: number;
  /** Every run in the current incident has ended (or nothing stalled). */
  readonly settled: boolean;
  /** Runs are open, but every one waits on the user (a fault not recovered): the counter stopped. */
  readonly waiting: boolean;
  /** Step reached by simulation tick `t` (events and traces are placed with it). */
  stepOfTick(t: number): number;
  /**
   * Tick `t` of the current incident is counted: before its first run (step 0), or while some
   * run is open and not waiting on the user. False once the incident has settled, and while it
   * waits for recovery: the counter stays where it is then.
   */
  counting(t: number): boolean;
}

const NO_OP: ArrayOpSteps = { startT: null, endT: null, holds: [], milestones: [], crashed: false };

interface Incident {
  readonly byVm: Map<string, VmSteps[]>;
  readonly ops: ArrayOpSteps[];
  readonly runs: RunSpan[];
}

export class StepTracker {
  private readonly samples = new Map<string, StepSample[]>();
  private cache: { key: string; view: StepsView } | null = null;
  private lastTick = -1;
  /** Highest step shown so far: the counter never goes backwards while a run is in progress. */
  private peak = 0;
  /** First tick of the current incident; earlier samples belong to past incidents. */
  private incidentFrom = 0;
  private readonly past: { from: number; runs: readonly RunSpan[] }[] = [];
  /** Ids of the array and its controllers (a failure there ends a planned operation). */
  private readonly arrayParts = new Set<string>();
  /** Per VM: its runs, read once from its samples (not again on every tick). */
  private readonly scanners = new Map<string, RunScanner>();
  /** The event log by code, extended as it grows. */
  private index = new EventIndex();

  constructor(private readonly source: Pick<Simulation, 'getSnapshot' | 'subscribe' | 'eventLog'>) {
    const s = source.getSnapshot();
    for (const d of Object.values(s.devices)) {
      if (d.kind === 'fa-array' || d.kind === 'fa-controller') this.arrayParts.add(d.id);
    }
    this.record(s);
    source.subscribe(() => this.record(source.getSnapshot()));
  }

  record(s: Snapshot): void {
    if (s.simTime < this.lastTick) {
      this.samples.clear();
      this.scanners.clear();
      this.index = new EventIndex();
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
        stuckPct: typeof f.stuckIoPct === 'number' ? f.stuckIoPct : undefined,
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
   * Start a new incident if the current one has settled (every run ended, or nothing ever
   * stalled): the counter restarts from 0 for whatever happens from tick `t` on. Called when the
   * user applies an action; a new interruption after a settled incident also starts one.
   */
  beginIncidentIfSettled(t: number): void {
    const v = this.view();
    if (!v.settled || this.incidentFrom === t) return;
    this.past.push({ from: this.incidentFrom, runs: v.runs });
    this.incidentFrom = t;
    this.peak = 0;
    this.cache = null;
  }

  view(): StepsView {
    const log: readonly SimEvent[] = this.source.eventLog();
    const key = `${this.lastTick}:${log.length}:${this.source.getSnapshot().version}:${this.incidentFrom}`;
    if (this.cache?.key === key) return this.cache.view;
    if (log.length < this.index.size) this.index = new EventIndex();
    this.index.append(log);
    const events = this.index;
    const faults = faultWindows(events, (id) => this.samples.has(id));
    let inc = this.derive(events, faults, this.incidentFrom);
    // A settled incident followed by a new run: that run opens a new incident.
    for (;;) {
      const split = splitAt(inc.runs);
      if (split === null || split > this.lastTick) break;
      this.past.push({
        from: this.incidentFrom,
        runs: inc.runs.filter((r) => (r.startT as number) < split),
      });
      this.incidentFrom = split;
      this.peak = 0;
      inc = this.derive(events, faults, split);
    }
    const from = this.incidentFrom;
    const past = [...this.past];
    const runs = inc.runs;
    const stepOfTick = (t: number): number => {
      const pick = t >= from ? runs : [...past].reverse().find((p) => t >= p.from)?.runs;
      let n = 0;
      for (const s of pick ?? []) n = Math.max(n, stepAt(s, t));
      return n;
    };
    this.peak = Math.max(this.peak, stepOfTick(this.lastTick));
    const firstStart = Math.min(
      ...runs.map((r) => r.startT ?? Number.POSITIVE_INFINITY),
      Number.POSITIVE_INFINITY,
    );
    const counting = (t: number): boolean =>
      t >= from && (t < firstStart || runs.some((r) => countsAt(r, t)));
    const open = runs.filter((r) => r.endT === null);
    const vms = new Map<string, VmSteps>();
    for (const [id, list] of inc.byVm) vms.set(id, summarizeVmRuns(id, list));
    const view: StepsView = {
      vms,
      array: inc.ops[inc.ops.length - 1] ?? NO_OP,
      runs,
      samples: this.samples,
      from,
      current: this.peak,
      settled: open.length === 0,
      waiting: open.length > 0 && open.every((r) => isWaiting(r, this.lastTick)),
      stepOfTick,
      counting,
    };
    this.cache = { key, view };
    return view;
  }

  private derive(
    events: EventIndex,
    faults: ReturnType<typeof faultWindows>,
    from: number,
  ): Incident {
    const byVm = new Map<string, VmSteps[]>();
    const runs: RunSpan[] = [];
    for (const [id, series] of this.samples) {
      let scanner = this.scanners.get(id);
      if (scanner === undefined) {
        scanner = new RunScanner();
        this.scanners.set(id, scanner);
      }
      const list = finishRuns(id, events, series, scanner.scans(series), faults, from);
      byVm.set(id, list);
      runs.push(...list);
    }
    const parts = this.arrayParts;
    const ops = deriveArrayOps(events, from, parts.size > 0 ? (id) => parts.has(id) : undefined);
    runs.push(...ops);
    return { byVm, ops, runs };
  }
}

/**
 * The tick a new incident starts at: one after every run so far had ended, when a later run
 * starts after that; null while the runs overlap (or one is still open).
 */
function splitAt(runs: readonly RunSpan[]): number | null {
  const started = runs
    .filter((r) => r.startT !== null)
    .sort((a, b) => (a.startT as number) - (b.startT as number));
  let end = Number.NEGATIVE_INFINITY;
  for (const [i, r] of started.entries()) {
    if (i > 0 && (r.startT as number) > end) return end + 1;
    if (r.endT === null) return null;
    end = Math.max(end, r.endT);
  }
  return null;
}
