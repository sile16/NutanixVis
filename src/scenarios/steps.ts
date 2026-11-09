/**
 * Scenario readers for the steps view (`src/domain/steps`). Expectations built on these check
 * ORDER and relationships between steps, never durations (the steps are an ordinal scale).
 */
import { deriveVmSteps, ioChainOf, type VmSteps, vmSeries } from '../domain/steps';
import type { ScenarioContext } from './context';
import type { Expectation, GuideObservation, ScenarioGuide } from './define';
import { atCtx, device, snapshotAt } from './helpers';

export function stepsOf(ctx: ScenarioContext, vmId: string): VmSteps {
  return deriveVmSteps(vmId, ctx.events, vmSeries(ctx.history, vmId));
}

/** Step of a stage in the derived milestones, or null if the stage never happened. */
export const stepOfStage = (steps: VmSteps, stage: string): number | null =>
  steps.milestones.find((m) => m.stage === stage)?.step ?? null;

/** Tick a stage was reached (internal ordering only), or null. */
export const tickOfStage = (steps: VmSteps, stage: string): number | null =>
  steps.milestones.find((m) => m.stage === stage)?.t ?? null;

/** The VM's `ioChain` hop roles at tick `t`, in order. */
export function chainRolesAt(ctx: ScenarioContext, vmId: string, t: number): string[] {
  const chain = ioChainOf(device(snapshotAt(ctx, t), vmId));
  return chain === null ? [] : chain.hops.map((h) => h.role);
}

/** True when one guide observation holds in the VM's derived steps. */
function observationHolds(st: VmSteps, o: GuideObservation): boolean {
  if (o.stage !== undefined) {
    const step = stepOfStage(st, o.stage);
    if (step === null || (o.step !== undefined && step !== o.step)) return false;
  }
  if (o.io === 'none') return st.startT === null;
  if (o.io === 'partial') return st.peakStuckPct > 0 && st.peakStuckPct < 100;
  if (o.io === 'all') return st.peakStuckPct === 100;
  return true;
}

/**
 * Expectations that hold the guided tour to the run: every observation happens (at its stated
 * step, with its stated IO share) and each group's staged observations come in the order listed.
 */
export function guideChecks(guide: ScenarioGuide, at: number): Expectation[] {
  const out: Expectation[] = [];
  guide.groups.forEach((group, g) => {
    for (const o of group) {
      const where = [o.stage, o.step === undefined ? null : `step ${o.step}`, o.io]
        .filter(Boolean)
        .join(', ');
      out.push(
        atCtx(at, `guide ${g + 1}: ${where}`, (_s, ctx) =>
          observationHolds(stepsOf(ctx, guide.vm), o),
        ),
      );
    }
    out.push(
      atCtx(at, `guide ${g + 1}: observations in the order listed`, (_s, ctx) => {
        const st = stepsOf(ctx, guide.vm);
        const ticks = group.flatMap((o) =>
          o.stage === undefined ? [] : [tickOfStage(st, o.stage)],
        );
        return ticks.every((t, i) => t !== null && (i === 0 || t >= (ticks[i - 1] ?? 0)));
      }),
    );
  });
  return out;
}
