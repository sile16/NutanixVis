/**
 * Opt-in probe: runs EVERY scenario (todo included) against the real composition and writes a
 * pass/fail report. Use while turning `todo` scenarios into `active` ones:
 *   SCENARIO_PROBE=out.json pnpm vitest run tests/scenario-probe.test.ts
 */
import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { scenarios } from '../src/scenarios/index';
import { defaultSimulationFactory, runScenario } from '../src/scenarios/runner';

const out = process.env.SCENARIO_PROBE;

describe.skipIf(!out)('scenario probe', () => {
  it('runs every scenario and writes a report', () => {
    const factory = defaultSimulationFactory();
    const report: Record<string, string | string[]> = {};
    for (const def of scenarios) {
      try {
        const r = runScenario({ ...def, status: 'active' }, factory, { keepHistory: true });
        report[def.id] =
          r.failures.length === 0
            ? 'PASS'
            : r.failures.map((f) => `${f.label} @${f.t}: ${f.reason}`);
      } catch (e) {
        report[def.id] = `ERROR: ${(e as Error).message}`;
      }
    }
    writeFileSync(out ?? 'scenario-probe.json', JSON.stringify(report, null, 1));
  }, 900_000);
});
