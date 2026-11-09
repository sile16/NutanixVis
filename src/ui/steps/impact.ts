/**
 * Per-VM impact by step (pure). For every workload and every step: `normal`, `partial` (some of
 * its IO stuck, the rest completing), `stalled` (all IO), `redirected` (served by another CVM) or
 * `recovered`, each with a text, so the colour is never the only signal. A VM that no step ever touched has no row: the strip says how many ran without an
 * interruption instead, and names a bond that moved traffic when that is why.
 */

import { stuckPctOf } from '../../domain/steps';
import type { Snapshot } from '../../engine/types';
import { nicIsDown } from '../diagram/data-path';
import type { StepSample, StepsView } from './step-tracker';

export type CellKind = 'normal' | 'partial' | 'stalled' | 'redirected' | 'recovered';

export interface ImpactCell {
  readonly step: number;
  readonly kind: CellKind;
  /** Visible text, for example "stalled" or "via CVM 2". */
  readonly text: string;
}

export interface ImpactRow {
  readonly vm: string;
  readonly label: string;
  readonly cells: readonly ImpactCell[];
  /** Steps the IO was stalled; 0 = never interrupted (it was only redirected). */
  readonly stalledSteps: number;
  /** One-line result for the end of the row. */
  readonly summary: string;
}

export interface ImpactModel {
  readonly steps: number;
  readonly rows: readonly ImpactRow[];
  /** VMs that were never stalled or redirected. */
  readonly unaffected: number;
  /** Bond members down while the bond still carries traffic: what "no interruption" rests on. */
  readonly bondMoves: readonly string[];
}

/** Tolerance for IO issued in the last snapshots: in flight, not stuck. */
const IN_FLIGHT = 2;

const isStalled = (s: StepSample): boolean =>
  s.state === 'io-stalled' ||
  s.state === 'crashed' ||
  s.state === 'restarting' ||
  s.state === 'off' ||
  (s.state === 'running' && s.ioPendingS > IN_FLIGHT);

const parseList = (v: unknown): string[] => {
  if (typeof v !== 'string') return [];
  try {
    const x: unknown = JSON.parse(v);
    return Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : [];
  } catch {
    return [];
  }
};

/** Bonds that lost a member but still have one carrying traffic. */
export function bondMoves(s: Pick<Snapshot, 'devices' | 'links'>): string[] {
  const out: string[] = [];
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
    out.push(
      `${host} ${d.label}: ${lost.map(name).join(', ')} down, traffic moved to ${alive.map(name).join(', ')}`.trim(),
    );
  }
  return out;
}

export function buildImpact(
  view: StepsView,
  snapshot: Pick<Snapshot, 'devices' | 'links'>,
): ImpactModel {
  const devices = snapshot.devices;
  const steps = view.current;
  const rows: ImpactRow[] = [];
  let unaffected = 0;
  const label = (id: string | null): string => (id ? (devices[id]?.label ?? id) : 'none');

  for (const [vm, all] of view.samples) {
    // A spare VM that has not been powered on yet is not an affected VM; its time off before
    // the first start is not an outage either.
    const firstOn = all.findIndex((x) => x.state !== 'off');
    if (firstOn < 0) continue;
    const series = all.slice(firstOn);
    if (series.length === 0) continue;
    const base = series.find((s) => s.ownerCvm !== null)?.ownerCvm ?? null;
    const touched = series.some(
      (s) => isStalled(s) || (s.ownerCvm !== null && s.ownerCvm !== base),
    );
    if (!touched) {
      unaffected++;
      continue;
    }
    const cells: ImpactCell[] = [];
    let hadImpact = false;
    for (let step = 0; step <= steps; step++) {
      // The VM's state at the end of this step: the last sample not past it.
      let at: StepSample | undefined;
      for (const s of series) if (view.stepOfTick(s.t) <= step) at = s;
      let cell: ImpactCell;
      if (!at || step === 0) cell = { step, kind: 'normal', text: 'normal' };
      else if (isStalled(at)) {
        const pct = stuckPctOf({ ...at, state: at.state === 'off' ? 'crashed' : at.state });
        cell =
          pct < 100
            ? { step, kind: 'partial', text: `${pct}% of IO stalled` }
            : { step, kind: 'stalled', text: 'all IO stalled' };
      } else if (at.ownerCvm !== null && at.ownerCvm !== base) {
        cell = { step, kind: 'redirected', text: `via ${label(at.ownerCvm)}` };
      } else if (hadImpact) cell = { step, kind: 'recovered', text: 'recovered' };
      else cell = { step, kind: 'normal', text: 'normal' };
      if (cell.kind !== 'normal' && cell.kind !== 'recovered') hadImpact = true;
      cells.push(cell);
    }
    const vs = view.vms.get(vm);
    const stalledSteps = vs?.stalledSteps ?? 0;
    const last = cells[cells.length - 1];
    const peak = vs?.peakStuckPct ?? 100;
    const what = peak > 0 && peak < 100 ? `up to ${peak}% of IO stalled` : 'stalled';
    rows.push({
      vm,
      label: label(vm),
      cells,
      stalledSteps,
      summary:
        stalledSteps === 0
          ? 'no interruption'
          : vs?.resumeStep === null
            ? `${what} ${stalledSteps}+ step${stalledSteps === 1 ? '' : 's'}`
            : `${what} ${stalledSteps} step${stalledSteps === 1 ? '' : 's'}${last?.kind === 'redirected' ? ', then redirected' : ''}`,
    });
  }
  rows.sort((a, b) => a.vm.localeCompare(b.vm));
  return { steps, rows, unaffected, bondMoves: bondMoves(snapshot) };
}
