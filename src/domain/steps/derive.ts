/**
 * Derive the steps view of a VM's interruption from the engine's event log and the VM's
 * snapshots (headless; the UI only reads the result).
 *
 * The engine ticks on its own internal clock. This module reads ORDER, not duration:
 * - an interruption is a run of snapshots where the VM's IO is stalled or waiting;
 * - the stages that happened during it (`STAGES`) are placed in step ordinals, in causal order;
 * - the impact is the number of steps the VM was stalled, on a relative scale.
 *
 * `BLIP` is the pipeline-fill tolerance, not a timing claim: IO issued in the last snapshot or
 * two is in flight, not stuck (the same tolerance the scenarios call SLACK).
 */
import type { SimEvent, Snapshot } from '../../engine/types';
import { type ImpactScale, STAGES, type StepStage } from './stages';

const BLIP = 2;

export interface VmSample {
  readonly t: number;
  readonly state: string;
  readonly ioPendingS: number;
  readonly host: string | null;
  readonly ownerCvm: string | null;
}

export interface StepMilestone {
  readonly stage: StepStage;
  /** Step ordinal; recovery stages continue after the resume step. */
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
  /** Interruption milestones, then recovery milestones, in step order. */
  readonly milestones: readonly StepMilestone[];
  /** Cell strip for the impact bar: one entry per step, `stalled` while the IO was stuck. */
  readonly cells: readonly ('stalled' | 'ok')[];
  /** The VM was served by a different CVM after the interruption (the redirect happened). */
  readonly redirected: boolean;
}

export function vmSeries(history: readonly Snapshot[], vm: string): VmSample[] {
  const out: VmSample[] = [];
  for (const s of history) {
    const f = s.devices[vm]?.fields;
    if (!f) continue;
    out.push({
      t: s.simTime,
      state: String(f.state),
      ioPendingS: typeof f.ioPendingS === 'number' ? f.ioPendingS : 0,
      host: typeof f.host === 'string' ? f.host : null,
      ownerCvm: typeof f.ownerCvm === 'string' ? f.ownerCvm : null,
    });
  }
  return out;
}

const impacted = (x: VmSample): boolean =>
  x.state === 'io-stalled' || (x.state === 'running' && x.ioPendingS > BLIP);

const NONE = (vm: string): VmSteps => ({
  vm,
  stalledSteps: 0,
  impact: 'none',
  resumeStep: 0,
  milestones: [],
  cells: [],
  redirected: false,
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
  const start = (series[first] as VmSample).t;
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
  const add = (stage: StepStage, t: number, device: string | null, step?: number): void => {
    const info = STAGES[stage];
    ms.push({ stage, step: step ?? info.step ?? 0, t, device });
  };
  add('stall', start, cvm);
  const all = ofCvm('nvme.all-paths.lost');
  const some = events.find((e) => e.code === 'nvme.path.lost' && e.deviceId === cvm && within(e));
  if (all) add('all-paths-lost', all.t, cvm);
  // A lost path is only a reroute once the IO is observed to complete again: while the VM is
  // still stalled the remaining paths may yet be lost too, so the stage must not advance (and
  // later fall back to "all paths lost"). A prefix of a run therefore never shows a later step
  // than the full run does.
  else if (some && !stillStalled) add('path-rerouted', some.t, cvm);
  const maint = ofCvm('hades.maintenance.enter');
  if (maint) add('maintenance', maint.t, cvm);
  const stopped = ofCvm('hades.services.stopped');
  if (stopped) add('services-stopped', stopped.t, cvm);
  const redirect = hostEvt('redirector.redirect');
  // The VM's vDisk is served by another CVM (the owner changed) even where the redirect event is
  // not logged (a planned shutdown). With no maintenance step before it, a CVM or Stargate
  // failure goes straight from the stall to the redirect: step 2, then the IO resumes in step 3.
  const moved = series
    .slice(first, last + 2)
    .find((x) => x.ownerCvm !== null && x.ownerCvm !== cvm);
  const redirectT = redirect?.t ?? moved?.t;
  if (redirectT !== undefined) add('redirected', redirectT, host, maint || stopped ? undefined : 2);
  // Every path lost and the paths come back inside the interruption (a short outage, no
  // service stop): the reconnect is what ends it, one step after the stall.
  const reconnected =
    all && !maint
      ? events.find(
          (e) => e.code === 'nvme.path.restored' && e.deviceId === cvm && e.t > all.t && e.t <= end,
        )
      : undefined;
  if (reconnected) add('path-restored', reconnected.t, cvm, 2);
  ms.sort((a, b) => a.step - b.step || a.t - b.t);

  const lastMs = ms[ms.length - 1] as StepMilestone;
  const fix = reconnected !== undefined || STAGES[lastMs.stage].resumesInStep;
  const resumeStep = stillStalled ? null : lastMs.step + (fix ? 0 : 1);
  if (resumeStep !== null && after) add('resumed', after.t, null, resumeStep);

  // Recovery: continues after the resume step; never interrupts the VM.
  let next = (resumeStep ?? lastMs.step) + 1;
  const recover = (stage: StepStage, e: SimEvent | undefined): void => {
    if (e) add(stage, e.t, e.deviceId ?? null, next++);
  };
  const restoredAt = (code: string, dev: string | null, from: number): SimEvent | undefined =>
    events.find((e) => e.code === code && e.deviceId === dev && e.t > from);
  if (maint) {
    const exit = restoredAt('hades.maintenance.exit', cvm, maint.t);
    recover('maintenance-exited', exit);
    const up = exit ? restoredAt('stargate.up', cvm, exit.t) : undefined;
    recover('services-restarted', up);
    const fb = up ? restoredAt('redirector.failback', host, up.t) : undefined;
    recover('failed-back', fb);
  } else if (redirectT !== undefined) {
    // CVM or Stargate failure without maintenance mode: Stargate comes back, then the sessions
    // return to the local CVM much later.
    const up = restoredAt('stargate.up', cvm, start);
    recover('services-restarted', up);
    const fb = restoredAt('redirector.failback', host, up?.t ?? start);
    recover('failed-back', fb);
  } else if (some && !reconnected) {
    recover('path-restored', restoredAt('nvme.path.restored', cvm, start));
  }

  const sorted = [...ms].sort((a, b) => a.step - b.step || a.t - b.t);
  const stalledSteps = resumeStep ?? lastMs.step;
  const redirected = redirectT !== undefined && after !== undefined && after.ownerCvm !== cvm;
  const impact: ImpactScale = redirected
    ? 'redirected'
    : stalledSteps <= 1
      ? 'brief'
      : maint
        ? 'longer'
        : 'brief';
  return {
    vm,
    stalledSteps,
    impact,
    resumeStep,
    milestones: sorted,
    cells: Array.from({ length: stalledSteps }, () => 'stalled' as const),
    redirected,
  };
}

/** The highest step whose milestone has been reached by tick `t` (0 before the interruption). */
export function stepAt(steps: VmSteps, t: number): number {
  let n = 0;
  for (const m of steps.milestones) if (m.t <= t && m.step > n) n = m.step;
  return n;
}

/** Tick of the next milestone after `t` (the "advance one step" target), or null. */
export function nextStepTick(steps: VmSteps, t: number): number | null {
  let best: number | null = null;
  for (const m of steps.milestones) if (m.t > t && (best === null || m.t < best)) best = m.t;
  return best;
}
