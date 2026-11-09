/**
 * Derive the steps view of a VM's interruptions from the engine's event log and the VM's
 * snapshots (headless; the UI only reads the result).
 *
 * The engine ticks on its own internal clock, and every component has its own timers; the
 * sequence is whatever they produce together. This module only reads it:
 * - an interruption is a run of snapshots where the VM's IO is stalled or waiting, or the VM is
 *   down; one VM can have several in a row (`deriveVmRuns`);
 * - the stages that happened during it (`STAGES`) are the events of the components, at the tick
 *   each happened;
 * - a stage's step is its slot on the compressive scale of the time since the interruption began
 *   (`scale.ts`); no stage owns a step number.
 *
 * Time a run spends waiting on the user is not counted (a `Hold`): the counter stops instead of
 * climbing forever. A run waits on the user when
 * - its IO has resumed elsewhere (redirect, maintenance mode) and only the failback is left, but
 *   the local Stargate is not back and a fault the user injected is still in place (a failed CVM,
 *   NIC or switch not recovered, a CVM shut down and not started): the failback cannot happen
 *   until the user acts;
 * - the VM is down with nothing restarting it: failed or paused by the user, or AHV HA found no
 *   host that can run it.
 * Once the user acts, counting picks up from the step it stopped at.
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

/**
 * A stretch of a run that the counter does not count: the run waits on the user (see the module
 * comment). Ticks, internal. `to` null: still waiting.
 */
export interface Hold {
  readonly from: number;
  readonly to: number | null;
}

/** The part of a run the step counter reads: when it began, when it ended, and its holds. */
export interface RunSpan {
  readonly startT: number | null;
  /** Tick the run ended, after which the counter stops; null: not yet. */
  readonly endT: number | null;
  /** Sorted, disjoint stretches that are not counted (absent: none). */
  readonly holds?: readonly Hold[] | undefined;
}

export interface VmSteps extends RunSpan {
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
   * redirect it is the failback; after an HA restart, or otherwise, the tick the IO completed
   * again.
   */
  readonly endT: number | null;
  readonly holds: readonly Hold[];
  /** Interruption milestones, then recovery milestones, in time order. */
  readonly milestones: readonly StepMilestone[];
  /** Cell strip for the impact bar: one entry per step, `stalled` while the IO was stuck. */
  readonly cells: readonly ('stalled' | 'ok')[];
  /**
   * The VM was served by a different CVM on the same host after the interruption (the redirect
   * happened). An HA restart or a live migration to another host is not a redirect.
   */
  readonly redirected: boolean;
  /** Host AHV HA (or a power-on) started the VM on after the interruption; null: it was not. */
  readonly restartedOn: string | null;
  /**
   * Largest share of the guest's IO stalled during the run, % (0 with no interruption). Below 100
   * the run was a partial stall: some IO kept completing (a silent path loss under queue-depth).
   */
  readonly peakStuckPct: number;
}

/**
 * The VM state a step sample records. A VM failed by the generic `fail` action keeps its own
 * `state` field (running) but its device is failed: that is a VM the user failed (`failed`), down
 * until the user recovers it. A VM whose host went down is failed too, but its own state says
 * what happened to it (crashed, restarting): that is kept, since AHV HA restarts it.
 */
export function vmSampleState(status: string, state: unknown): string {
  const own = String(state);
  return status === 'failed' && (own === 'running' || own === 'io-stalled') ? 'failed' : own;
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

/** The VM is down (not merely stalled): crashed, failed, paused, or restarting after HA. */
export const vmIsDown = (state: string): boolean =>
  state === 'crashed' || state === 'failed' || state === 'paused' || state === 'restarting';

/** The VM's IO is interrupted: stalled, waiting, or the VM itself is down. A powered-off VM
 * (a spare, or one the user stopped) is not an interruption. */
export const impacted = (x: VmSample): boolean =>
  x.state === 'io-stalled' || vmIsDown(x.state) || (x.state === 'running' && x.ioPendingS > BLIP);

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
  holds: [],
  milestones: [],
  cells: [],
  redirected: false,
  restartedOn: null,
  peakStuckPct: 0,
});

// ── Faults the user left in place ─────────────────────────────────────────

/** Events that put a fault in place, and the event that removes it (same device). */
const FAULT_PAIRS: Readonly<Record<string, string>> = {
  'device.failed': 'device.recovered',
  'action.hang': 'action.unhang',
  'action.switch.hang': 'action.unhang',
  'action.power-off': 'action.power-on',
  'action.host.isolate': 'action.host.unisolate',
  'action.cvm.planned-shutdown': 'action.cvm.planned-start',
  'action.cvm.stop-stargate': 'action.cvm.start-stargate',
  'action.cvm.hang-stargate': 'action.cvm.resume-stargate',
  'action.cvm.internal-link-down': 'action.cvm.internal-link-up',
  'action.fa.interface.disable': 'action.fa.interface.enable',
};
const FAULT_CLOSERS = new Set(Object.values(FAULT_PAIRS));

/**
 * Stretches during which at least one fault the user injected is still in place (failed and not
 * recovered, hung, powered off, isolated, stopped). `ignore` skips devices whose own faults never
 * block another run's recovery (the VMs: a failed VM holds only its own run).
 */
export function faultWindows(
  events: readonly SimEvent[] | EventIndex,
  ignore: (id: string) => boolean = () => false,
): Hold[] {
  const ev = indexOf(events);
  const codes = [...Object.keys(FAULT_PAIRS), ...FAULT_CLOSERS];
  const relevant = [...new Set(codes)].flatMap((c) => ev.of(c)).sort((a, b) => a.seq - b.seq);
  const open = new Set<string>();
  const out: Hold[] = [];
  let from = 0;
  for (const e of relevant) {
    const id = e.deviceId;
    if (id === undefined || ignore(id)) continue;
    const closer = FAULT_PAIRS[e.code];
    if (closer !== undefined) {
      if (open.size === 0) from = e.t;
      open.add(`${closer}|${id}`);
    } else if (open.delete(`${e.code}|${id}`) && open.size === 0 && e.t > from) {
      out.push({ from, to: e.t });
    }
  }
  if (open.size > 0) out.push({ from, to: null });
  return out;
}

/** Stretches without a Zookeeper quorum: no HA leader can act, so nothing restarts a VM. */
function noQuorumWindows(ev: EventIndex): Hold[] {
  const marks = [...ev.of('zk.quorum.lost'), ...ev.of('zk.quorum.restored')].sort(
    (a, b) => a.seq - b.seq,
  );
  const out: Hold[] = [];
  let from: number | null = null;
  for (const e of marks) {
    if (e.code === 'zk.quorum.lost') from ??= e.t;
    else if (from !== null) {
      if (e.t > from) out.push({ from, to: e.t });
      from = null;
    }
  }
  if (from !== null) out.push({ from, to: null });
  return out;
}

/** `ws` clipped to [from, to) (to null: open-ended). */
function clip(ws: readonly Hold[], from: number, to: number | null): Hold[] {
  const out: Hold[] = [];
  const end = to ?? Number.POSITIVE_INFINITY;
  for (const w of ws) {
    const a = Math.max(w.from, from);
    const b = Math.min(w.to ?? Number.POSITIVE_INFINITY, end);
    if (b > a) out.push({ from: a, to: b === Number.POSITIVE_INFINITY ? null : b });
  }
  return out;
}

/** Sorted, disjoint union of holds. */
function mergeHolds(hs: readonly Hold[]): Hold[] {
  const sorted = [...hs].sort((a, b) => a.from - b.from);
  const out: Hold[] = [];
  for (const h of sorted) {
    const last = out[out.length - 1];
    const lastEnd = last ? (last.to ?? Number.POSITIVE_INFINITY) : Number.NEGATIVE_INFINITY;
    if (last && h.from <= lastEnd) {
      const to = last.to === null || h.to === null ? null : Math.max(last.to, h.to as number);
      out[out.length - 1] = { from: last.from, to };
    } else out.push(h);
  }
  return out;
}

// ── Event lookup ──────────────────────────────────────────────────────────

/** The event log grouped by code, so a derivation over a long log stays cheap. */
export class EventIndex {
  private readonly byCode = new Map<string, SimEvent[]>();
  private n = 0;
  constructor(events: readonly SimEvent[] = []) {
    this.append(events);
  }
  /** Number of events indexed. */
  get size(): number {
    return this.n;
  }
  /** Index the events of `log` after the ones already indexed (`log` grows by appending). */
  append(log: readonly SimEvent[]): void {
    for (; this.n < log.length; this.n++) {
      const e = log[this.n] as SimEvent;
      const list = this.byCode.get(e.code);
      if (list) list.push(e);
      else this.byCode.set(e.code, [e]);
    }
  }
  of(code: string): readonly SimEvent[] {
    return this.byCode.get(code) ?? [];
  }
  find(code: string, pred: (e: SimEvent) => boolean): SimEvent | undefined {
    return this.of(code).find(pred);
  }
}

const indexOf = (events: readonly SimEvent[] | EventIndex): EventIndex =>
  events instanceof EventIndex ? events : new EventIndex(events);

// ── VM runs ───────────────────────────────────────────────────────────────

/** A VM waits on the user in this sample: failed or paused by the user (nothing restarts it). */
const userDown = (x: VmSample): boolean => x.state === 'failed' || x.state === 'paused';

/** Mutable while a run is being scanned. */
interface Span {
  from: number;
  to: number | null;
}

/**
 * What one run's samples say, gathered in one pass over them (`RunScanner`), so a long run is not
 * re-read on every tick. Indices are into the VM's series.
 */
export interface RunScan {
  readonly first: number;
  last: number;
  /** Host and serving CVM just before the run (the sample before it, or its first). */
  readonly host: string | null;
  readonly cvm: string | null;
  /** First sample the VM was down in. */
  downT: number | null;
  /** First sample served by another CVM while the VM stayed on its host. */
  movedT: number | null;
  peak: number;
  /** Stretches the VM was failed or paused by the user (`to` null: still at `last`). */
  readonly user: Span[];
  /** Stretches the VM was crashed or restarting. */
  readonly down: Span[];
}

function track(list: Span[], on: boolean, t: number): void {
  const last = list[list.length - 1];
  if (on) {
    if (last === undefined || last.to !== null) list.push({ from: t, to: null });
  } else if (last !== undefined && last.to === null) last.to = t;
}

function openScan(series: readonly VmSample[], i: number): RunScan {
  const head = series[i] as VmSample;
  const before = series[Math.max(0, i - 1)] as VmSample;
  return {
    first: i,
    last: i,
    host: before.host ?? head.host,
    cvm: before.ownerCvm,
    downT: null,
    movedT: null,
    peak: 0,
    user: [],
    down: [],
  };
}

function extendScan(scan: RunScan, x: VmSample, i: number): void {
  scan.last = i;
  if (scan.downT === null && vmIsDown(x.state)) scan.downT = x.t;
  if (
    scan.movedT === null &&
    x.ownerCvm !== null &&
    x.ownerCvm !== scan.cvm &&
    x.host !== null &&
    x.host === scan.host
  ) {
    scan.movedT = x.t;
  }
  scan.peak = Math.max(scan.peak, stuckPctOf(x));
  track(scan.user, userDown(x), x.t);
  track(scan.down, x.state === 'crashed' || x.state === 'restarting', x.t);
}

const cloneScan = (s: RunScan): RunScan => ({
  ...s,
  user: s.user.map((h) => ({ ...h })),
  down: s.down.map((h) => ({ ...h })),
});

/**
 * Splits a VM's series into runs of impacted samples, incrementally: samples already read are
 * not read again. The latest sample may still be replaced (an action queued at the same tick), so
 * it is applied to a copy on every call.
 */
export class RunScanner {
  private readonly closed: RunScan[] = [];
  private open: RunScan | null = null;
  private n = 0;

  private step(series: readonly VmSample[], i: number, into: RunScan[], open: RunScan | null) {
    const x = series[i] as VmSample;
    if (impacted(x)) {
      const run = open ?? openScan(series, i);
      extendScan(run, x, i);
      return run;
    }
    if (open !== null) into.push(open);
    return null;
  }

  /** Every run in `series` so far, in order (the last may be open). */
  scans(series: readonly VmSample[]): RunScan[] {
    if (this.n > series.length) throw new Error('RunScanner: the series shrank');
    for (; this.n < series.length - 1; this.n++) {
      this.open = this.step(series, this.n, this.closed, this.open);
    }
    const out = [...this.closed];
    const last = series.length - 1;
    const open =
      last >= this.n ? this.step(series, last, out, this.open && cloneScan(this.open)) : this.open;
    if (open !== null) out.push(open);
    return out;
  }
}

function finishRun(
  vm: string,
  ev: EventIndex,
  series: readonly VmSample[],
  scan: RunScan,
  faults: readonly Hold[],
  floor: number,
): VmSteps {
  const { first, last, host, cvm } = scan;
  // The interruption began when its oldest stuck IO was sent, not when the stall became visible
  // (`BLIP` later): the first impacted sample's pending age dates it (an IO younger than `BLIP`
  // in the sample before was not yet counted). An IO stamped tick k was sent during the tick
  // that ended at k, so the stall began at k − 1 (for a failure, the tick it was applied at);
  // never before the series starts (`floor`), or before the sample that ended the run before.
  const head = series[first] as VmSample;
  const start =
    head.state === 'running' || head.state === 'io-stalled'
      ? Math.max(floor, Math.min(head.t, Math.floor(head.t - head.ioPendingS) - 1))
      : head.t;
  const stillStalled = last === series.length - 1;
  const end = stillStalled ? Number.POSITIVE_INFINITY : (series[last + 1] as VmSample).t;
  const after = stillStalled ? undefined : (series[last + 1] as VmSample);

  const within = (e: SimEvent): boolean => e.t >= start && e.t <= end;
  const ofCvm = (code: string): SimEvent | undefined =>
    ev.find(code, (e) => e.deviceId === cvm && within(e));
  const hostEvt = (code: string): SimEvent | undefined =>
    ev.find(code, (e) => e.deviceId === host && within(e));
  const ofVm = (code: string): SimEvent | undefined =>
    ev.find(code, (e) => e.deviceId === vm && within(e));

  const raw: { stage: StepStage; t: number; device: string | null }[] = [];
  const add = (stage: StepStage, t: number, device: string | null): void => {
    raw.push({ stage, t, device });
  };
  if (vmIsDown(head.state)) add('vm-down', start, vm);
  else {
    add('stall', start, cvm);
    // A VM that stalled first and then went down (self-terminated, host lost).
    if (scan.downT !== null) add('vm-down', scan.downT, vm);
  }
  const all = ofCvm('nvme.all-paths.lost');
  const some = ofCvm('nvme.path.lost');
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
  // The VM ends up on another host: AHV HA restarted it (or the user powered it on there). That
  // is its own outcome, not a redirect, and nothing fails back to it later.
  const haRestart = ofVm('ha.vm.restarted');
  const restartedOn =
    after !== undefined && after.host !== null && (haRestart !== undefined || after.host !== host)
      ? after.host
      : null;
  const redirect = hostEvt('redirector.redirect');
  // The VM's vDisk is served by another CVM while it stays on its host (the owner changed) even
  // where the redirect event is not logged (a planned shutdown). A move to another host (an HA
  // restart, a live migration) changes the owner too, but is not a redirect.
  const movedAfter =
    after !== undefined &&
    after.ownerCvm !== null &&
    after.ownerCvm !== cvm &&
    after.host !== null &&
    after.host === host;
  const redirectT = redirect?.t ?? scan.movedT ?? (movedAfter ? after.t : undefined);
  if (redirectT !== undefined) add('redirected', redirectT, host);
  if (haRestart) add('ha-restarted', haRestart.t, restartedOn);
  // Every path lost and the paths come back inside the interruption (a short outage, no
  // service stop): the reconnect is what ends it.
  const reconnected =
    all && !maint
      ? ev.find('nvme.path.restored', (e) => e.deviceId === cvm && e.t > all.t && e.t <= end)
      : undefined;
  if (reconnected) add('path-restored', reconnected.t, cvm);
  // Powered off by the user while down: the run ends, but the IO never completed again.
  const endedOff = after?.state === 'off';
  if (after && !endedOff) add('resumed', after.t, null);

  // Recovery: after the resume; never interrupts the VM. A VM restarted elsewhere has none (its
  // old host's failback is not its own).
  const recover = (stage: StepStage, e: SimEvent | undefined): void => {
    if (e) add(stage, e.t, e.deviceId ?? null);
  };
  const restoredAt = (code: string, dev: string | null, from: number): SimEvent | undefined =>
    ev.find(code, (e) => e.deviceId === dev && e.t > from);
  const failsBack = restartedOn === null && (maint !== undefined || redirectT !== undefined);
  let failedBackT: number | null = null;
  let stargateUp: SimEvent | undefined;
  if (failsBack && maint) {
    const exit = restoredAt('hades.maintenance.exit', cvm, maint.t);
    recover('maintenance-exited', exit);
    stargateUp = exit ? restoredAt('stargate.up', cvm, exit.t) : undefined;
    recover('services-restarted', stargateUp);
    const fb = stargateUp ? restoredAt('redirector.failback', host, stargateUp.t) : undefined;
    recover('failed-back', fb);
    failedBackT = fb?.t ?? null;
  } else if (failsBack) {
    // CVM or Stargate failure without maintenance mode: Stargate comes back, then the sessions
    // return to the local CVM much later.
    stargateUp = restoredAt('stargate.up', cvm, start);
    recover('services-restarted', stargateUp);
    const fb = restoredAt('redirector.failback', host, stargateUp?.t ?? start);
    recover('failed-back', fb);
    failedBackT = fb?.t ?? null;
  } else if (some && !reconnected && restartedOn === null) {
    recover('path-restored', restoredAt('nvme.path.restored', cvm, start));
  }

  // Holds (see the module comment). 1. The VM is down with nothing restarting it: failed or
  // paused by the user; or crashed while AHV HA cannot act (no host can run it, or the cluster
  // has no Zookeeper quorum, so there is no HA leader).
  const closeAt = after?.t ?? null;
  const spans = (list: readonly Span[]): Hold[] =>
    list.map((h) => ({ from: h.from, to: h.to ?? closeAt }));
  const holds: Hold[] = spans(scan.user);
  const down = spans(scan.down);
  const cannotRestart: Hold[] = [
    ...ev
      .of('ha.vm.restart-failed')
      .filter((e) => e.deviceId === vm && within(e))
      .map((e) => ({ from: e.t, to: null })),
    ...noQuorumWindows(ev),
  ];
  for (const w of cannotRestart) for (const d of down) holds.push(...clip([d], w.from, w.to));
  // 2. The IO resumed elsewhere and only the failback is left, but the local Stargate is not
  // back while a fault the user injected is in place: the failback cannot start until they act.
  if (failsBack && after) {
    holds.push(...clip(faults, after.t, stargateUp?.t ?? failedBackT));
  }
  const held = mergeHolds(holds);

  const endT = failsBack ? failedBackT : (after?.t ?? null);
  // Milestone steps are on the run's own clock without its end, so a recovery milestone after
  // the end (paths restored much later) still lands later.
  const clock: RunSpan = { startT: start, endT: null, holds: held };
  const stepOf = (t: number): number => stepAt(clock, t);
  const ms: StepMilestone[] = raw.map((m) => ({ ...m, step: stepOf(m.t) }));
  ms.sort((a, b) => a.t - b.t || a.step - b.step);
  const resumeStep = after ? stepOf(after.t) : null;
  // The IO completes again in the step it resumed in; the step before is the last stalled one,
  // so a stall that ends within its first step counts as one stalled step.
  const stalledSteps =
    resumeStep === null ? stepOf((series[last] as VmSample).t) : Math.max(1, resumeStep - 1);
  const redirected =
    restartedOn === null &&
    redirectT !== undefined &&
    after !== undefined &&
    after.ownerCvm !== cvm;
  const tail = series[last] as VmSample;
  const impact: ImpactScale =
    restartedOn !== null
      ? 'restarted'
      : endedOff || (after === undefined && vmIsDown(tail.state) && isWaiting(clock, tail.t))
        ? 'down'
        : redirected
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
    startT: start,
    endT,
    holds: held,
    milestones: ms,
    cells: Array.from({ length: stalledSteps }, () => 'stalled' as const),
    redirected,
    restartedOn,
    peakStuckPct: scan.peak,
  };
}

/**
 * Finish runs scanned from `series` (`RunScanner`, or one pass of it): the runs whose first sample
 * is at or after tick `from`, in order.
 */
export function finishRuns(
  vm: string,
  events: readonly SimEvent[] | EventIndex,
  series: readonly VmSample[],
  scans: readonly RunScan[],
  faults: readonly Hold[],
  from = Number.NEGATIVE_INFINITY,
): VmSteps[] {
  const ev = indexOf(events);
  const t0 = (series[0] as VmSample | undefined)?.t ?? 0;
  const at = (i: number): VmSample => series[i] as VmSample;
  // One interruption, even where a sample in between looked fine: a run whose oldest stuck IO
  // was sent before the run before it ended (a flapping link that lets a little IO through).
  const merged: { scan: RunScan; floor: number }[] = [];
  scans.forEach((scan, i) => {
    if (at(scan.first).t < from) return;
    const prev = merged[merged.length - 1];
    if (prev && sentAt(at(scan.first)) < at(prev.scan.last + 1).t) {
      prev.scan = joinScans(prev.scan, scan);
      return;
    }
    // Never dated before the series or the incident starts, or before the run before ended.
    const before = scans[i - 1];
    const floor = Math.max(t0, from, before ? at(before.last + 1).t : t0);
    merged.push({ scan, floor });
  });
  return merged.map(({ scan, floor }) => finishRun(vm, ev, series, scan, faults, floor));
}

/** Tick the oldest stuck IO of a run's first sample was sent (see `finishRun`), unclamped. */
function sentAt(head: VmSample): number {
  return head.state === 'running' || head.state === 'io-stalled'
    ? Math.min(head.t, Math.floor(head.t - head.ioPendingS) - 1)
    : head.t;
}

function joinScans(a: RunScan, b: RunScan): RunScan {
  return {
    ...a,
    last: b.last,
    downT: a.downT ?? b.downT,
    movedT: a.movedT ?? b.movedT,
    peak: Math.max(a.peak, b.peak),
    user: [...a.user.map((h) => ({ ...h })), ...b.user.map((h) => ({ ...h }))],
    down: [...a.down.map((h) => ({ ...h })), ...b.down.map((h) => ({ ...h }))],
  };
}

/**
 * Every interruption of `vm` in `series`, in time order (each a run of impacted samples). A VM
 * can be interrupted again while an incident is still open (failed, recovered, failed again);
 * each run has its own clock.
 *
 * `faults` are the stretches where a user fault is in place (`faultWindows`); by default every
 * fault in the log counts.
 */
export function deriveVmRuns(
  vm: string,
  events: readonly SimEvent[] | EventIndex,
  series: readonly VmSample[],
  faults?: readonly Hold[],
): VmSteps[] {
  const ev = indexOf(events);
  const scans = new RunScanner().scans(series);
  return finishRuns(vm, ev, series, scans, faults ?? faultWindows(ev));
}

/**
 * Steps of the first interruption of `vm` (the first run of impacted samples), or the "no
 * interruption" result when its IO never stalled (a bond that re-pinned, a blip).
 */
export function deriveVmSteps(
  vm: string,
  events: readonly SimEvent[] | EventIndex,
  series: readonly VmSample[],
  faults?: readonly Hold[],
): VmSteps {
  return deriveVmRuns(vm, events, series, faults)[0] ?? NONE(vm);
}

/**
 * One VM's interruptions in an incident as a single summary for display: from the first run's
 * start; open while any run is open; the last run's outcome. The counter reads the runs
 * themselves, not this summary.
 */
export function summarizeVmRuns(vm: string, runs: readonly VmSteps[]): VmSteps {
  const first = runs[0];
  const lastRun = runs[runs.length - 1];
  if (first === undefined || lastRun === undefined) return NONE(vm);
  if (runs.length === 1) return first;
  const open = runs.some((r) => r.endT === null);
  return {
    ...lastRun,
    startT: first.startT,
    endT: open ? null : Math.max(...runs.map((r) => r.endT as number)),
    holds: [],
    stalledSteps: runs.reduce((n, r) => n + r.stalledSteps, 0),
    milestones: runs.flatMap((r) => r.milestones),
    cells: runs.flatMap((r) => r.cells),
    peakStuckPct: Math.max(...runs.map((r) => r.peakStuckPct)),
  };
}

// ── The step counter of a run ─────────────────────────────────────────────

/** Ticks of the run counted by tick `t` (its start to `t`, minus its holds). */
function counted(span: RunSpan, t: number): number {
  const s = span.startT as number;
  let e = t - s;
  for (const h of span.holds ?? []) {
    if (h.from >= t) break;
    const a = Math.max(h.from, s);
    const b = Math.min(h.to ?? t, t);
    if (b > a) e -= b - a;
  }
  return e;
}

/**
 * The step the run has reached by tick `t` (0 before the interruption). It climbs with the time
 * since the interruption began, on the compressive scale, not counting its holds, and stops once
 * the run has ended (the sessions failed back, or the IO completed again).
 */
export function stepAt(steps: RunSpan, t: number): number {
  if (steps.startT === null || t < steps.startT) return 0;
  const until = steps.endT === null ? t : Math.min(t, steps.endT);
  return stepOfElapsed(counted(steps, until));
}

/**
 * Tick at which the step counter next advances after `t` (the "advance one step" target), or
 * null: the run ends first, or it is waiting on the user (an open hold).
 */
export function nextStepTick(steps: RunSpan, t: number): number | null {
  if (steps.startT === null) return null;
  if (t < steps.startT) return steps.startT;
  let at = steps.startT + stepBoundary(stepAt(steps, t) + 1);
  for (const h of steps.holds ?? []) {
    if (h.from >= at) break;
    if (h.to === null) return null;
    at += h.to - Math.max(h.from, steps.startT);
  }
  if (steps.endT !== null && at > steps.endT) return null;
  return at;
}

/**
 * Tick `t` is counted by the run: it lies between its start and its end (inclusive), and not
 * inside one of its holds (a hold's first and last ticks are counted).
 */
export function countsAt(steps: RunSpan, t: number): boolean {
  if (steps.startT === null || t < steps.startT) return false;
  if (steps.endT !== null && t > steps.endT) return false;
  return !(steps.holds ?? []).some((h) => h.from < t && (h.to === null || t < h.to));
}

/** The run is open but waiting on the user at tick `t`: its counter has stopped. */
export function isWaiting(steps: RunSpan, t: number): boolean {
  return (
    steps.startT !== null &&
    steps.endT === null &&
    (steps.holds ?? []).some((h) => h.to === null && h.from <= t)
  );
}

// ── Planned array operations ──────────────────────────────────────────────

/**
 * A planned array operation as a run of its own (a controller reboot, or an NDU): the counter
 * climbs through its drain, reboot and return although no VM stalls.
 */
export interface ArrayOpSteps extends RunSpan {
  readonly holds: readonly Hold[];
  readonly milestones: readonly StepMilestone[];
  /** The operation ended because a controller it depends on failed (not completed). */
  readonly crashed: boolean;
}

const OP_STAGES: Readonly<Record<string, StepStage>> = {
  'fa.controller.draining': 'controller-draining',
  'fa.controller.rebooting': 'controller-rebooting',
  'fa.controller.online': 'controller-online',
  'fa.promotion.complete': 'controller-failover',
};

/** NDU events that show it moving on after a pause for hosts. */
const NDU_PROGRESS = [
  'fa.giveback',
  'fa.promotion.start',
  'fa.controller.draining',
  'fa.ndu.complete',
];

const NO_OP: ArrayOpSteps = { startT: null, endT: null, holds: [], milestones: [], crashed: false };

/** Default `isArrayPart`: the array itself, or a controller (`<array>.ct<n>`). */
const defaultArrayPart = (array: string, id: string): boolean =>
  id === array || new RegExp(`^${array.replace(/\./g, '\\.')}\\.ct\\d+$`).test(id);

/**
 * The first planned array operation that starts at or after tick `from` (none: startT null).
 *
 * It ends when it completes, or when the array or one of its controllers fails during it (the
 * operation stops there; what follows is an unplanned failure, counted by the VMs it stalls). An
 * NDU that pauses for hosts that have not reconnected waits on the user: that pause is a hold.
 * `isArrayPart` names the array and its controllers (default: by id).
 */
export function deriveArrayOpSteps(
  events: readonly SimEvent[] | EventIndex,
  from: number,
  isArrayPart?: (id: string) => boolean,
): ArrayOpSteps {
  const ev = indexOf(events);
  const starts = [...ev.of('fa.ndu.start'), ...ev.of('fa.controller.draining')]
    .filter((e) => e.t >= from)
    .sort((a, b) => a.t - b.t || a.seq - b.seq);
  const first = starts[0];
  if (!first) return NO_OP;
  const start = first.t;
  const ndu = first.code === 'fa.ndu.start';
  const self = first.deviceId ?? '';
  const array = ndu ? self : self.slice(0, Math.max(0, self.lastIndexOf('.')));
  const done = ndu
    ? ev.find('fa.ndu.complete', (e) => e.t >= start)
    : ev.find('fa.controller.online', (e) => e.deviceId === self && e.t >= start);
  const part = isArrayPart ?? ((id: string) => defaultArrayPart(array, id));
  const crash = ev.find(
    'device.failed',
    (e) =>
      e.t >= start &&
      (done === undefined || e.t <= done.t) &&
      e.deviceId !== undefined &&
      (ndu ? part(e.deviceId) : e.deviceId === self || e.deviceId === array),
  );
  const endT = crash?.t ?? done?.t ?? null;
  const end = endT ?? Number.POSITIVE_INFINITY;
  const holds: Hold[] = [];
  if (ndu) {
    for (const w of ev.of('fa.ndu.waiting-for-hosts')) {
      if (w.t < start || w.t > end) continue;
      const on = NDU_PROGRESS.flatMap((c) => ev.of(c)).filter((e) => e.t > w.t && e.t <= end);
      const to = on.length > 0 ? Math.min(...on.map((e) => e.t)) : null;
      holds.push({ from: w.t, to: to ?? endT });
    }
  }
  const held = mergeHolds(holds);
  const clock: RunSpan = { startT: start, endT: null, holds: held };
  const milestones: StepMilestone[] = [];
  const opEvents = Object.keys(OP_STAGES)
    .flatMap((c) => ev.of(c))
    .sort((a, b) => a.seq - b.seq);
  for (const e of opEvents) {
    const stage = OP_STAGES[e.code];
    if (stage === undefined || e.t < start || e.t > end) continue;
    // A single reboot has no failover; only an NDU's promotion belongs to the operation.
    if (stage === 'controller-failover' && !ndu) continue;
    if (!ndu && e.deviceId !== self) continue;
    milestones.push({ stage, step: stepAt(clock, e.t), t: e.t, device: e.deviceId ?? null });
  }
  return { startT: start, endT, holds: held, milestones, crashed: crash !== undefined };
}

/** Every planned array operation from tick `from` on, in order (the last one may be open). */
export function deriveArrayOps(
  events: readonly SimEvent[] | EventIndex,
  from: number,
  isArrayPart?: (id: string) => boolean,
): ArrayOpSteps[] {
  const ev = indexOf(events);
  const out: ArrayOpSteps[] = [];
  let at = from;
  for (;;) {
    const op = deriveArrayOpSteps(ev, at, isArrayPart);
    if (op.startT === null) break;
    out.push(op);
    if (op.endT === null) break;
    at = op.endT + 1;
  }
  return out;
}
