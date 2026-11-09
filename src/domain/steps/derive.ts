/**
 * Derive the steps view of a VM's interruption from the engine's event log and the VM's
 * snapshots (headless; the UI only reads the result).
 *
 * The engine ticks on its own internal clock, and every component has its own timers; the
 * sequence is whatever they produce together. This module only reads it:
 * - an interruption is a run of snapshots where the VM's IO is stalled or waiting;
 * - the stages that happened during it (`STAGES`) are the events of the components, at the tick
 *   each happened;
 * - a stage's step is its slot on the compressive scale of the time since the interruption began
 *   (`scale.ts`); no stage owns a step number.
 *
 * `BLIP` is the pipeline-fill tolerance, not a timing claim: IO issued in the last snapshot or
 * two is in flight, not stuck (the same tolerance the scenarios call SLACK).
 */
import type { SimEvent, Snapshot } from '../../engine/types';
import { stepBoundary, stepOfElapsed } from './scale';
import type { ImpactScale, StepStage } from './stages';

const BLIP = 2;

export interface VmSample {
  readonly t: number;
  readonly state: string;
  readonly ioPendingS: number;
  readonly host: string | null;
  readonly ownerCvm: string | null;
  /** Share of the guest's queue slots held by stuck IO, % (`stuckIoPct`; 100 = all IO stalled). */
  readonly stuckPct?: number | undefined;
}

export interface StepMilestone {
  readonly stage: StepStage;
  /** The stage's slot on the relative step scale (`scale.ts`). */
  readonly step: number;
  /** Engine tick the stage was reached (internal; the UI orders by it, never prints it). */
  readonly t: number;
  readonly device: string | null;
}

export interface VmSteps {
  readonly vm: string;
  /** Number of steps the VM's IO was stalled (0: no interruption). */
  readonly stalledSteps: number;
  readonly impact: ImpactScale;
  /** Step in which the IO completed again (0 when it never stalled; null: still stalled). */
  readonly resumeStep: number | null;
  /** Tick the interruption began (internal), or null when the VM never stalled. */
  readonly startT: number | null;
  /**
   * Tick the run ended, after which the counter stops; null: not yet. With maintenance or a
   * redirect it is the failback; otherwise the tick the IO completed again.
   */
  readonly endT: number | null;
  /** Interruption milestones, then recovery milestones, in time order. */
  readonly milestones: readonly StepMilestone[];
  /** Cell strip for the impact bar: one entry per step, `stalled` while the IO was stuck. */
  readonly cells: readonly ('stalled' | 'ok')[];
  /** The VM was served by a different CVM after the interruption (the redirect happened). */
  readonly redirected: boolean;
  /**
   * Largest share of the guest's IO stalled during the run, % (0 with no interruption). Below 100
   * the run was a partial stall: some IO kept completing (a silent path loss under queue-depth).
   */
  readonly peakStuckPct: number;
}

/**
 * The VM state a step sample records. A VM failed by the generic `fail` action keeps its own
 * `state` field but its device is failed: that is a crashed VM, not a running one.
 */
export function vmSampleState(status: string, state: unknown): string {
  return status === 'failed' ? 'crashed' : String(state);
}

export function vmSeries(history: readonly Snapshot[], vm: string): VmSample[] {
  const out: VmSample[] = [];
  for (const s of history) {
    const d = s.devices[vm];
    const f = d?.fields;
    if (!d || !f) continue;
    out.push({
      t: s.simTime,
      state: vmSampleState(d.status, f.state),
      ioPendingS: typeof f.ioPendingS === 'number' ? f.ioPendingS : 0,
      host: typeof f.host === 'string' ? f.host : null,
      ownerCvm: typeof f.ownerCvm === 'string' ? f.ownerCvm : null,
      stuckPct: typeof f.stuckIoPct === 'number' ? f.stuckIoPct : undefined,
    });
  }
  return out;
}

/** The VM's IO is interrupted: stalled, waiting, or the VM itself is down (crashed, paused, or
 * restarting after HA). A powered-off spare is not an interruption. */
const impacted = (x: VmSample): boolean =>
  x.state === 'io-stalled' ||
  x.state === 'crashed' ||
  x.state === 'paused' ||
  x.state === 'restarting' ||
  (x.state === 'running' && x.ioPendingS > BLIP);

/**
 * Share of the VM's IO stalled in a sample, %: the model's `stuckIoPct` when present; otherwise
 * 100 for a VM whose IO is interrupted (stalled, down) and 0 for one that runs.
 */
export function stuckPctOf(x: VmSample): number {
  if (!impacted(x)) return 0;
  if (x.state !== 'running') return 100;
  return x.stuckPct ?? 100;
}

const NONE = (vm: string): VmSteps => ({
  vm,
  stalledSteps: 0,
  impact: 'none',
  resumeStep: 0,
  startT: null,
  endT: null,
  milestones: [],
  cells: [],
  redirected: false,
  peakStuckPct: 0,
});

/**
 * Steps of the first interruption of `vm` (the first run of impacted samples), or the "no
 * interruption" result when its IO never stalled (a bond that re-pinned, a blip).
 */
export function deriveVmSteps(
  vm: string,
  events: readonly SimEvent[],
  series: readonly VmSample[],
): VmSteps {
  const first = series.findIndex(impacted);
  if (first < 0) return NONE(vm);
  let last = first;
  while (last + 1 < series.length && impacted(series[last + 1] as VmSample)) last++;
  // The interruption began when its oldest stuck IO was sent, not when the stall became visible
  // (`BLIP` later): the first impacted sample's pending age dates it (an IO younger than `BLIP`
  // in the sample before was not yet counted). An IO stamped tick k was sent during the tick
  // that ended at k, so the stall began at k − 1 (for a failure, the tick it was applied at);
  // never before the series starts.
  const head = series[first] as VmSample;
  const floor = (series[0] as VmSample).t;
  const start =
    head.state === 'running' || head.state === 'io-stalled'
      ? Math.max(floor, Math.min(head.t, Math.floor(head.t - head.ioPendingS) - 1))
      : head.t;
  const stillStalled = last === series.length - 1;
  const end = stillStalled ? Number.POSITIVE_INFINITY : (series[last + 1] as VmSample).t;
  const before = series[Math.max(0, first - 1)] as VmSample;
  const host = before.host;
  const cvm = before.ownerCvm;
  const after = stillStalled ? undefined : (series[last + 1] as VmSample);

  const within = (e: SimEvent): boolean => e.t >= start && e.t <= end;
  const ofCvm = (code: string): SimEvent | undefined =>
    events.find((e) => e.code === code && e.deviceId === cvm && within(e));
  const hostEvt = (code: string): SimEvent | undefined =>
    events.find((e) => e.code === code && e.deviceId === host && within(e));

  const ms: StepMilestone[] = [];
  const stepOf = (t: number): number => stepOfElapsed(t - start);
  const add = (stage: StepStage, t: number, device: string | null): void => {
    ms.push({ stage, step: stepOf(t), t, device });
  };
  add('stall', start, cvm);
  const all = ofCvm('nvme.all-paths.lost');
  const some = events.find((e) => e.code === 'nvme.path.lost' && e.deviceId === cvm && within(e));
  if (all) add('all-paths-lost', all.t, cvm);
  // A lost path is only a reroute once the IO is observed to complete again: while the VM is
  // still stalled the remaining paths may yet be lost too, so the stage must not appear (and
  // later fall back to "all paths lost"). A prefix of a run therefore never shows a stage that
  // the full run does not.
  else if (some && !stillStalled) add('path-rerouted', some.t, cvm);
  const maint = ofCvm('hades.maintenance.enter');
  if (maint) add('maintenance', maint.t, cvm);
  const stopped = ofCvm('hades.services.stopped');
  if (stopped) add('services-stopped', stopped.t, cvm);
  const redirect = hostEvt('redirector.redirect');
  // The VM's vDisk is served by another CVM (the owner changed) even where the redirect event is
  // not logged (a planned shutdown).
  const moved = series
    .slice(first, last + 2)
    .find((x) => x.ownerCvm !== null && x.ownerCvm !== cvm);
  const redirectT = redirect?.t ?? moved?.t;
  if (redirectT !== undefined) add('redirected', redirectT, host);
  // Every path lost and the paths come back inside the interruption (a short outage, no
  // service stop): the reconnect is what ends it.
  const reconnected =
    all && !maint
      ? events.find(
          (e) => e.code === 'nvme.path.restored' && e.deviceId === cvm && e.t > all.t && e.t <= end,
        )
      : undefined;
  if (reconnected) add('path-restored', reconnected.t, cvm);

  const resumeStep = after ? stepOf(after.t) : null;
  if (after) add('resumed', after.t, null);

  // Recovery: after the resume; never interrupts the VM.
  const recover = (stage: StepStage, e: SimEvent | undefined): void => {
    if (e) add(stage, e.t, e.deviceId ?? null);
  };
  const restoredAt = (code: string, dev: string | null, from: number): SimEvent | undefined =>
    events.find((e) => e.code === code && e.deviceId === dev && e.t > from);
  let failedBackT: number | null = null;
  if (maint) {
    const exit = restoredAt('hades.maintenance.exit', cvm, maint.t);
    recover('maintenance-exited', exit);
    const up = exit ? restoredAt('stargate.up', cvm, exit.t) : undefined;
    recover('services-restarted', up);
    const fb = up ? restoredAt('redirector.failback', host, up.t) : undefined;
    recover('failed-back', fb);
    failedBackT = fb?.t ?? null;
  } else if (redirectT !== undefined) {
    // CVM or Stargate failure without maintenance mode: Stargate comes back, then the sessions
    // return to the local CVM much later.
    const up = restoredAt('stargate.up', cvm, start);
    recover('services-restarted', up);
    const fb = restoredAt('redirector.failback', host, up?.t ?? start);
    recover('failed-back', fb);
    failedBackT = fb?.t ?? null;
  } else if (some && !reconnected) {
    recover('path-restored', restoredAt('nvme.path.restored', cvm, start));
  }

  ms.sort((a, b) => a.t - b.t || a.step - b.step);
  // The IO completes again in the step it resumed in; the step before is the last stalled one,
  // so a stall that ends within its first step counts as one stalled step.
  const stalledSteps =
    resumeStep === null ? stepOf((series[last] as VmSample).t) : Math.max(1, resumeStep - 1);
  const redirected = redirectT !== undefined && after !== undefined && after.ownerCvm !== cvm;
  const impact: ImpactScale = redirected
    ? 'redirected'
    : stalledSteps <= 1
      ? 'brief'
      : maint
        ? 'longer'
        : 'brief';
  // The run ends when the sessions fail back (maintenance or redirect); otherwise when the IO
  // completes again. Later recovery milestones (a path restored much later) don't extend it, so
  // the counter stops instead of creeping up the scale forever.
  const endT = maint || redirectT !== undefined ? failedBackT : (after?.t ?? null);
  return {
    vm,
    stalledSteps,
    impact,
    resumeStep,
    startT: start,
    endT,
    milestones: ms,
    cells: Array.from({ length: stalledSteps }, () => 'stalled' as const),
    redirected,
    peakStuckPct: series.slice(first, last + 1).reduce((m, x) => Math.max(m, stuckPctOf(x)), 0),
  };
}

/**
 * The step the run has reached by tick `t` (0 before the interruption). It climbs with the time
 * since the interruption began, on the compressive scale, and stops once the sessions have
 * failed back.
 */
export function stepAt(steps: VmSteps, t: number): number {
  if (steps.startT === null || t < steps.startT) return 0;
  const until = steps.endT === null ? t : Math.min(t, steps.endT);
  return stepOfElapsed(until - steps.startT);
}

/** Tick at which the step counter next advances after `t` (the "advance one step" target), or null. */
export function nextStepTick(steps: VmSteps, t: number): number | null {
  if (steps.startT === null) return null;
  const at = t < steps.startT ? steps.startT : steps.startT + stepBoundary(stepAt(steps, t) + 1);
  if (steps.endT !== null && at > steps.endT) return null;
  return at;
}
