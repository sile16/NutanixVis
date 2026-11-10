/**
 * Scenario registry (SPEC §7). The test suite and the UI's scenario picker both read this.
 * Ids are `<family>-<item>-<slug>`, where item is the SPEC §7.2 backlog number; one backlog item
 * may have several variants. The guided scenarios (`./guided`, the UI's Scenario tab) are
 * `guided-<n>-<slug>--<configuration>`.
 */
import type { ScenarioDef } from './define';
import { guidedScenarios } from './guided';
import { t1Scenarios } from './t1';
import { t1LabScenarios } from './t1-lab';
import { t2Scenarios } from './t2';
import { t3Scenarios } from './t3';

export type ScenarioFamily = 't1' | 't1lab' | 't2' | 't3' | 'guided';

export const scenariosByFamily: Readonly<Record<ScenarioFamily, readonly ScenarioDef[]>> = {
  t1: t1Scenarios,
  t1lab: t1LabScenarios,
  t2: t2Scenarios,
  t3: t3Scenarios,
  guided: guidedScenarios,
};

export const scenarios: readonly ScenarioDef[] = [
  ...t1Scenarios,
  ...t2Scenarios,
  ...t3Scenarios,
  ...t1LabScenarios,
  ...guidedScenarios,
];

export function getScenario(id: string): ScenarioDef {
  const def = scenarios.find((s) => s.id === id);
  if (!def) throw new Error(`Unknown scenario id: ${id}`);
  return def;
}

/** `{ family, item }` parsed from a scenario id such as `t1-07-host-power-loss`. */
export function backlogRef(id: string): { family: ScenarioFamily; item: number } | null {
  const m = /^(t1lab|t1|t2|t3|guided)-(\d{2})-/.exec(id);
  if (!m?.[1] || !m[2]) return null;
  return { family: m[1] as ScenarioFamily, item: Number(m[2]) };
}
