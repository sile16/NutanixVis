/**
 * Scenario readers for the steps view (`src/domain/steps`). Expectations built on these check
 * ORDER and relationships between steps, never durations (the steps are an ordinal scale).
 */
import {
  type ArrayOpSteps,
  deriveArrayOpSteps,
  deriveVmSteps,
  faultWindows,
  ioChainOf,
  type StepMilestone,
  type VmSteps,
  vmSeries,
} from '../domain/steps';
import type { ScenarioContext } from './context';
import type { Expectation, GuideObservation, ScenarioGuide } from './define';
import { atCtx, device, snapshotAt } from './helpers';

/** Ids of the scenario's devices of the given kinds (from its first snapshot). */
const idsOfKind = (ctx: ScenarioContext, kinds: readonly string[]): Set<string> =>
  new Set(
    Object.values(ctx.history[0]?.devices ?? {})
      .filter((d) => kinds.includes(d.kind))
      .map((d) => d.id),
  );

/** The VM's first interruption. A failed VM's own fault never holds another run (tracker rule). */
export function stepsOf(ctx: ScenarioContext, vmId: string): VmSteps {
  const vms = idsOfKind(ctx, ['vm']);
  const faults = faultWindows(ctx.events, (id) => vms.has(id));
  return deriveVmSteps(vmId, ctx.events, vmSeries(ctx.history, vmId), faults);
}

/** The scenario's first planned array operation (a controller reboot or an NDU). */
export function arrayStepsOf(ctx: ScenarioContext): ArrayOpSteps {
  const parts = idsOfKind(ctx, ['fa-array', 'fa-controller']);
  return deriveArrayOpSteps(ctx.events, 0, parts.size > 0 ? (id) => parts.has(id) : undefined);
}

type WithMilestones = { readonly milestones: readonly StepMilestone[] };

/** Step of a stage in the derived milestones, or null if the stage never happened. */
export const stepOfStage = (steps: WithMilestones, stage: string): number | null =>
  steps.milestones.find((m) => m.stage === stage)?.step ?? null;

/** Tick a stage was reached (internal ordering only), or null. */
export const tickOfStage = (steps: WithMilestones, stage: string): number | null =>
  steps.milestones.find((m) => m.stage === stage)?.t ?? null;

/** The VM's milestones, then the array operation's (a guide reads both). */
const guideRun = (ctx: ScenarioContext, vm: string): VmSteps & WithMilestones => {
  const st = stepsOf(ctx, vm);
  return { ...st, milestones: [...st.milestones, ...arrayStepsOf(ctx).milestones] };
};

/** The VM's `ioChain` hop roles at tick `t`, in order. */
export function chainRolesAt(ctx: ScenarioContext, vmId: string, t: number): string[] {
  const chain = ioChainOf(device(snapshotAt(ctx, t), vmId));
  return chain === null ? [] : chain.hops.map((h) => h.role);
}

/** True when one guide observation holds in the VM's derived steps (and the array operation's). */
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
          observationHolds(guideRun(ctx, guide.vm), o),
        ),
      );
    }
    out.push(
      atCtx(at, `guide ${g + 1}: observations in the order listed`, (_s, ctx) => {
        const st = guideRun(ctx, guide.vm);
        const ticks = group.flatMap((o) =>
          o.stage === undefined ? [] : [tickOfStage(st, o.stage)],
        );
        return ticks.every((t, i) => t !== null && (i === 0 || t >= (ticks[i - 1] ?? 0)));
      }),
    );
  });
  return out;
}
