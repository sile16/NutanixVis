/**
 * Per-VM impact by step (pure). For every workload and every step of the current incident:
 * `normal`, `partial` (some of its IO stuck, the rest completing), `stalled` (all IO), `down`
 * (the VM itself is not running: crashed, failed, paused or restarting), `redirected` (served by
 * another CVM on its own host) or `recovered`, each with a text, so the colour is never the only
 * signal. A cell shows the worst state the VM was in at any moment of its step, so a stall that
 * begins and ends inside one step still shows. A VM that no step ever touched has no row: the
 * strip says how many ran without an interruption instead, and names a bond that moved traffic
 * when that is why. A VM the user powered off, and a VM live-migrated to another host (AHV
 * maintenance mode), are not interruptions.
 *
 * Cheap to rebuild on every snapshot: one pass over each VM's samples of the incident, with the
 * step of each tick computed once per tick, and finished steps cached per incident.
 */

import { stuckPctOf, vmIsDown } from '../../domain/steps';
import type { Snapshot } from '../../engine/types';
import { nicIsDown } from '../diagram/data-path';
import type { StepSample, StepsView } from './step-tracker';

export type CellKind = 'normal' | 'partial' | 'stalled' | 'down' | 'redirected' | 'recovered';

export interface ImpactCell {
  readonly step: number;
  readonly kind: CellKind;
  /** Visible text, for example "stalled" or "via CVM 2". */
  readonly text: string;
  /** The "now" cell: the VM's state while the counter has stopped (not a step of its own). */
  readonly now?: true;
}

export interface ImpactRow {
  readonly vm: string;
  readonly label: string;
  /** One cell per step, 0 to `steps`; then the "now" cell while the counter has stopped. */
  readonly cells: readonly ImpactCell[];
  /** While the counter has stopped (`ImpactModel.now`): the VM's state now (the last cell). */
  readonly now: ImpactCell | null;
  /** Steps in which the VM was interrupted (stalled, partly stalled, or down); 0 = never. */
  readonly stalledSteps: number;
  /** One-line result for the end of the row. */
  readonly summary: string;
}

export interface ImpactModel {
  readonly steps: number;
  readonly rows: readonly ImpactRow[];
  /**
   * The counter has stopped: `waiting` for recovery, or the incident `settled`. Each row then has
   * a "now" cell after its steps (null: the counter is running, or nothing happened).
   */
  readonly now: 'waiting' | 'settled' | null;
  /** VMs that were never stalled or redirected. */
  readonly unaffected: number;
  /** Bond members down while the bond still carries traffic: what "no interruption" rests on. */
  readonly bondMoves: readonly string[];
}

/** Tolerance for IO issued in the last snapshots: in flight, not stuck. */
const IN_FLIGHT = 2;

const isStalled = (s: StepSample): boolean =>
  s.state === 'io-stalled' || (s.state === 'running' && s.ioPendingS > IN_FLIGHT);

const parseList = (v: unknown): string[] => {
  if (typeof v !== 'string') return [];
  try {
    const x: unknown = JSON.parse(v);
    return Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : [];
  } catch {
    return [];
  }
};

/** `Node 1`, `Node 2` → `Nodes 1, 2`; other host labels are listed as they are. */
function hostList(hosts: readonly string[]): string {
  if (hosts.length < 2) return hosts[0] ?? '';
  const nums = hosts.map((h) => /^Node (\S+)$/.exec(h)?.[1]);
  return nums.every((n) => n !== undefined) ? `Nodes ${nums.join(', ')}` : hosts.join(', ');
}

/**
 * Bonds that lost a member but still have one carrying traffic. The same move on several hosts
 * (a switch failure hits every node's bond alike) reads as one line naming the hosts.
 */
export function bondMoves(s: Pick<Snapshot, 'devices' | 'links'>): string[] {
  const groups = new Map<string, string[]>();
  const { devices } = s;
  for (const d of Object.values(devices)) {
    if (d.kind !== 'bond' && d.kind !== 'vswitch') continue;
    const members = parseList(d.fields.members);
    if (members.length < 2) continue;
    const lost = members.filter((m) => nicIsDown(s, m));
    const alive = members.filter((m) => !nicIsDown(s, m));
    if (lost.length === 0 || alive.length === 0) continue;
    const host = d.parent ? (devices[d.parent]?.label ?? d.parent) : '';
    const name = (m: string) => devices[m]?.label ?? m;
    const move = `${d.label}: ${lost.map(name).join(', ')} down, traffic moved to ${alive.map(name).join(', ')}`;
    groups.set(move, [...(groups.get(move) ?? []), host]);
  }
  return [...groups].map(([move, hosts]) => `${hostList(hosts.filter(Boolean))} ${move}`.trim());
}

/** The worst state of one sample, ranked (higher is worse). */
interface Worst {
  readonly rank: number;
  readonly kind: CellKind;
  readonly pct: number;
  /** `down`: what the VM is doing; `redirected`: the serving CVM. */
  readonly what: string;
}

const NORMAL: Worst = { rank: 0, kind: 'normal', pct: 0, what: '' };
const OFF: Worst = { rank: 0, kind: 'normal', pct: 0, what: 'off' };

const DOWN_TEXT: Readonly<Record<string, string>> = {
  crashed: 'down',
  failed: 'down',
  paused: 'paused',
  restarting: 'restarting',
};

/** Classify a sample; `base` is the CVM that serves the VM normally on its current host. */
function classify(s: StepSample, base: string | null): Worst {
  if (s.state === 'off') return OFF;
  if (vmIsDown(s.state))
    return { rank: 5, kind: 'down', pct: 100, what: DOWN_TEXT[s.state] ?? 'down' };
  if (isStalled(s)) {
    const pct = stuckPctOf(s);
    return pct < 100
      ? { rank: 3, kind: 'partial', pct, what: '' }
      : { rank: 4, kind: 'stalled', pct: 100, what: '' };
  }
  if (s.ownerCvm !== null && base !== null && s.ownerCvm !== base) {
    return { rank: 2, kind: 'redirected', pct: 0, what: s.ownerCvm };
  }
  return NORMAL;
}

const worse = (a: Worst, b: Worst): Worst =>
  b.rank > a.rank || (b.rank === a.rank && b.pct > a.pct) ? b : a;

/** Per-VM cache of finished steps: samples before `next` are folded into `worst`. */
interface VmCache {
  from: number;
  /** Index of the first sample not yet folded in. */
  next: number;
  /** The last sample folded in (a reset replaces the sample lists). */
  lastFolded: StepSample | undefined;
  /** Worst state per step, for steps up to the one the last folded sample is in. */
  worst: Worst[];
  /** State at the last counted sample of each step (how the step ended). */
  ended: Worst[];
  touched: boolean;
  /** Serving CVM on the current host while nothing is wrong (null: not seen yet). */
  base: string | null;
  host: string | null;
  firstOnSeen: boolean;
}

/**
 * Cache for `buildImpact` across snapshots of one incident: steps already finished are not
 * recomputed. One per steps tracker (the strip keeps it in a ref); omit it to compute afresh.
 */
export class ImpactCache {
  readonly vms = new Map<string, VmCache>();
}

const caches = new WeakMap<object, ImpactCache>();

/** The cache for the tracker behind `view` (its sample map lives as long as the tracker). */
export function impactCacheFor(view: Pick<StepsView, 'samples'>): ImpactCache {
  let c = caches.get(view.samples);
  if (c === undefined) {
    c = new ImpactCache();
    caches.set(view.samples, c);
  }
  return c;
}

export function buildImpact(
  view: StepsView,
  snapshot: Pick<Snapshot, 'devices' | 'links'>,
  cache: ImpactCache = new ImpactCache(),
): ImpactModel {
  const devices = snapshot.devices;
  const steps = view.current;
  const rows: ImpactRow[] = [];
  let unaffected = 0;
  const label = (id: string | null): string => (id ? (devices[id]?.label ?? id) : 'none');
  const from = view.from;
  // The step of each tick, once per tick for every VM (all VMs sample the same ticks).
  const stepMemo = new Map<number, number>();
  const stepOf = (t: number): number => {
    let s = stepMemo.get(t);
    if (s === undefined) {
      s = view.stepOfTick(t);
      stepMemo.set(t, s);
    }
    return s;
  };
  const countMemo = new Map<number, boolean>();
  const countedAt = (t: number): boolean => {
    let c = countMemo.get(t);
    if (c === undefined) {
      c = view.counting(t);
      countMemo.set(t, c);
    }
    return c;
  };
  let lastTick = from;
  for (const list of view.samples.values()) {
    const l = list[list.length - 1];
    if (l !== undefined) lastTick = Math.max(lastTick, l.t);
  }
  // Same test as the clock: a press stops on the tick the hold begins, which still counts.
  const nowShown = steps > 0 && (view.waiting || view.settled || !view.counting(lastTick));

  for (const [vm, all] of view.samples) {
    let c = cache.vms.get(vm);
    // A new incident (or a reset) starts the VM's strip again.
    if (
      c === undefined ||
      c.from !== from ||
      c.next > all.length ||
      (c.next > 0 && all[c.next - 1] !== c.lastFolded)
    ) {
      let next = 0;
      while (next < all.length && (all[next] as StepSample).t < from) next++;
      c = {
        from,
        next,
        lastFolded: next > 0 ? all[next - 1] : undefined,
        worst: [],
        ended: [],
        touched: false,
        base: null,
        host: null,
        firstOnSeen: false,
      };
      cache.vms.set(vm, c);
    }
    // The latest sample may be replaced at the same tick (an action queued then): only samples
    // of finished ticks are folded in for good; the latest one is classified each time.
    const end = all.length - 1;
    const fold = (s: StepSample, into: Worst[], state: VmCache, ended: Worst[]): void => {
      // A spare VM that has not been powered on yet is not an affected VM; its time off before
      // the first start is not an outage either.
      if (!state.firstOnSeen) {
        if (s.state === 'off') return;
        state.firstOnSeen = true;
      }
      if (s.host !== state.host) {
        // A new host (an HA restart, a live migration): its own CVM is the normal one there.
        state.host = s.host;
        state.base = null;
      }
      if (state.base === null && s.ownerCvm !== null && !isStalled(s) && !vmIsDown(s.state)) {
        state.base = s.ownerCvm;
      }
      const w = classify(s, state.base);
      if (w.rank > 0) state.touched = true;
      // Ticks the counter does not count (waiting for recovery, after the incident settled)
      // belong to no step: the "now" cell shows them.
      if (!countedAt(s.t)) return;
      const k = stepOf(s.t);
      into[k] = worse(into[k] ?? NORMAL, w);
      ended[k] = w;
    };
    for (; c.next < end; c.next++) {
      c.lastFolded = all[c.next];
      fold(c.lastFolded as StepSample, c.worst, c, c.ended);
    }
    // The latest sample, on a scratch copy.
    const worst = [...c.worst];
    const ended = [...c.ended];
    const scratch: VmCache = { ...c, worst, ended };
    const latest = all[end];
    if (latest !== undefined && latest.t >= from) fold(latest, worst, scratch, ended);
    if (!scratch.firstOnSeen) continue;
    if (!scratch.touched) {
      unaffected++;
      continue;
    }
    const cells: ImpactCell[] = [];
    let hadImpact = false;
    let carry: Worst = NORMAL;
    let interrupted = 0;
    // A step whose IO stalled but ran again before it ended says so: "all IO stalled, then via
    // CVM 2" (the cell keeps the stall's colour; the guided list ticks "resumed" at that step).
    const endText = (end: Worst | undefined): string =>
      end === undefined || end.rank >= 3
        ? ''
        : end.kind === 'redirected'
          ? `, then via ${label(end.what)}`
          : end.what === 'off'
            ? ''
            : ', then resumed';
    const cellOf = (step: number, w: Worst, end?: Worst): ImpactCell => {
      if (w.kind === 'down') return { step, kind: 'down', text: w.what };
      if (w.kind === 'partial')
        return { step, kind: 'partial', text: `${w.pct}% of IO stalled${endText(end)}` };
      if (w.kind === 'stalled')
        return { step, kind: 'stalled', text: `all IO stalled${endText(end)}` };
      if (w.kind === 'redirected')
        return { step, kind: 'redirected', text: `via ${label(w.what)}` };
      if (hadImpact) return { step, kind: 'recovered', text: 'recovered' };
      return { step, kind: 'normal', text: w.what === 'off' ? 'powered off' : 'normal' };
    };
    for (let step = 0; step <= steps; step++) {
      // A step with no counted sample of its own keeps the state before.
      const w = worst[step] ?? carry;
      carry = w;
      const cell =
        step === 0
          ? { step, kind: 'normal' as const, text: 'normal' }
          : cellOf(step, w, worst[step] === undefined ? undefined : ended[step]);
      if (cell.kind !== 'normal' && cell.kind !== 'recovered') hadImpact = true;
      if (cell.kind === 'down' || cell.kind === 'partial' || cell.kind === 'stalled') interrupted++;
      cells.push(cell);
    }
    // The counter has stopped (waiting for recovery, or settled): what the VM is doing now.
    const now: ImpactCell | null =
      nowShown && latest !== undefined
        ? { ...cellOf(steps, classify(latest, scratch.base)), now: true }
        : null;
    if (now) cells.push(now);
    const vs = view.vms.get(vm);
    const last = cells[cells.length - 1];
    const open = vs !== undefined && vs.startT !== null && vs.resumeStep === null;
    const plural = (n: number) => `${n} step${n === 1 ? '' : 's'}`;
    const peak = vs?.peakStuckPct ?? 100;
    const hit = cells.filter(
      (x) => x.kind === 'down' || x.kind === 'partial' || x.kind === 'stalled',
    );
    const what = hit.every((x) => x.kind === 'down')
      ? 'down'
      : peak > 0 && peak < 100
        ? `up to ${peak}% of IO stalled`
        : 'stalled';
    const wasRedirected = cells.some((x) => x.kind === 'redirected');
    const then =
      last?.kind === 'redirected'
        ? ', then redirected'
        : wasRedirected && last?.kind === 'recovered'
          ? ', redirected, then failed back'
          : '';
    let summary: string;
    if (interrupted === 0)
      summary = wasRedirected ? 'no interruption, redirected' : 'no interruption';
    else if (vs?.impact === 'restarted' && !open) {
      summary = `down ${plural(interrupted)}, restarted by AHV HA on ${label(vs.restartedOn)}`;
    } else if (open && view.waiting && last?.kind === 'down') {
      summary = `down ${plural(interrupted)}, waiting for recovery`;
    } else if (open) summary = `${what} ${interrupted}+ step${interrupted === 1 ? '' : 's'}`;
    else summary = `${what} ${plural(interrupted)}${then}`;
    rows.push({ vm, label: label(vm), cells, now, stalledSteps: interrupted, summary });
  }
  rows.sort((a, b) => a.vm.localeCompare(b.vm));
  return {
    steps,
    rows,
    now: nowShown ? (view.waiting ? 'waiting' : 'settled') : null,
    unaffected,
    bondMoves: bondMoves(snapshot),
  };
}
