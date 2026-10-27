/**
 * Scenario contract (SPEC §7.1, §13.1). One file serves both the Vitest acceptance test and the
 * UI's guided scenario. Stream H authors scenarios; the shape is owned by the integrator.
 */
import type { ActionRequest, CitationId, SimTime, Snapshot } from '../engine/types';

export interface ScenarioStep {
  /** Simulated second at which the action is queued. */
  readonly at: SimTime;
  readonly action: ActionRequest;
  /** Shown in the guided tour when this step runs. */
  readonly note?: string;
}

export type Expectation =
  | { readonly label: string; readonly at: SimTime; readonly that: (s: Snapshot) => boolean }
  | { readonly label: string; readonly always: true; readonly that: (s: Snapshot) => boolean };

export interface ScenarioDef {
  readonly id: string;
  readonly title: string;
  /** Topology id (see `src/topologies`). */
  readonly topology: string;
  readonly options?: Readonly<Record<string, string | number | boolean>>;
  /** Omit to use the newest Nutanix release and its newest supported FlashArray release. */
  readonly versions?: { readonly nutanix?: string; readonly flasharray?: string };
  readonly seed?: number;
  /** How long the test runs, in simulated seconds (default: last step/expectation + 10). */
  readonly durationS?: SimTime;
  readonly timeline: readonly ScenarioStep[];
  readonly expect: readonly Expectation[];
  readonly narrative: string;
  readonly cite: readonly CitationId[];
  /**
   * `todo`: written test-first; the runner registers it as `it.todo` until the domain lands.
   * `active`: must pass in CI.
   */
  readonly status: 'todo' | 'active';
}

export function defineScenario(def: ScenarioDef): ScenarioDef {
  return def;
}
