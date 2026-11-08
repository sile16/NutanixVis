/**
 * The UI shows relative steps, never seconds (owner decision 2026-11-08): event-log texts name
 * the timer that fired ("past the IO delay timeout"), not its value, and never print ticks.
 * Every scenario (active and todo) is replayed and its event texts checked.
 */
import { describe, expect, it } from 'vitest';
import { scenarios } from '../src/scenarios';
import type { SimulationFactory } from '../src/scenarios/runner';
import { defaultSimulationFactory, runScenario } from '../src/scenarios/runner';

const TIME = /\b\d+(\.\d+)?\s?(s|ms|sec|secs|seconds|min|minutes)\b|\b[tT]=\d/;
const base = defaultSimulationFactory();
/** The runner keeps codes only; capture the simulation to read the full event log. */
let last: ReturnType<SimulationFactory> | null = null;
const factory: SimulationFactory = (o) => {
  last = base(o);
  return last;
};

describe('event texts carry no seconds or ticks', () => {
  it.each(scenarios.map((s) => [s.id, s] as const))('%s', (_id, def) => {
    runScenario(def, factory, { keepHistory: false });
    const bad = (last?.eventLog() ?? []).map((e) => e.text).filter((t) => TIME.test(t));
    expect(bad).toEqual([]);
  });
});
