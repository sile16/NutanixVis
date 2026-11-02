/**
 * Scenario readers for the steps view (`src/domain/steps`). Expectations built on these check
 * ORDER and relationships between steps, never durations (the steps are an ordinal scale).
 */
import { deriveVmSteps, ioChainOf, type VmSteps, vmSeries } from '../domain/steps';
import type { ScenarioContext } from './context';
import { device, snapshotAt } from './helpers';

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
