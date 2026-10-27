/**
 * Headless scenario runner (SPEC §7.1). Drives a `Simulation` through a scenario's timeline,
 * checks `at` expectations on exactly that tick and `always` expectations on every tick, and
 * returns a golden list of event codes for snapshot review.
 *
 * Timing: the snapshot at simTime t is checked first, then steps with `at === t` are queued; they
 * apply at the start of the next tick (`Simulation.applyAction`), so they show from snapshot t+1.
 */
import type { SimEvent, SimTime, Simulation, Snapshot } from '../engine/types';
import { loadSimulation } from '../loader/simulation';
import { type TopologyId, topologyIds } from '../topologies';
import { evaluate, type ScenarioContext } from './context';
import type { ScenarioDef } from './define';

export interface SimulationRequest {
  readonly topology: string;
  readonly options: Readonly<Record<string, string | number | boolean>>;
  readonly versions?: { readonly nutanix?: string; readonly flasharray?: string };
  readonly seed: number;
}

/** Builds a fresh simulation (injected so the runner stays engine-agnostic and testable). */
export type SimulationFactory = (req: SimulationRequest) => Simulation;

/**
 * The real factory: topology + options + versions → engine simulation via the loader. Domain
 * device models plug in through `loadSimulation({ domain })` as they land (Phase 2).
 */
export function defaultSimulationFactory(): SimulationFactory {
  return (req) => {
    if (!isTopologyId(req.topology)) throw new Error(`unknown topology ${req.topology}`);
    return loadSimulation({
      topologyId: req.topology,
      options: req.options,
      seed: req.seed,
      ...(req.versions ? { versions: req.versions } : {}),
    }).sim;
  };
}

function isTopologyId(id: string): id is TopologyId {
  return (topologyIds as readonly string[]).includes(id);
}

export interface ExpectationFailure {
  readonly label: string;
  readonly kind: 'at' | 'always';
  /** First tick it failed on (or the tick it was due, if never evaluated). */
  readonly t: SimTime;
  readonly reason: string;
}

export interface ScenarioResult {
  readonly failures: readonly ExpectationFailure[];
  /** `"<t>\t<code>[@<deviceId>]"` per non-debug event, in log order. */
  readonly eventCodes: readonly string[];
  readonly final: Snapshot;
  readonly ticks: number;
}

export const DEFAULT_SEED = 1;

/** `durationS`, or the last step/`at` expectation + 10 (the `define.ts` default). */
export function scenarioDuration(def: ScenarioDef): SimTime {
  if (def.durationS !== undefined) return def.durationS;
  const times = [
    ...def.timeline.map((st) => st.at),
    ...def.expect.flatMap((e) => ('at' in e ? [e.at] : [])),
  ];
  return Math.max(0, ...times) + 10;
}

export const goldenCode = (e: SimEvent): string =>
  `${e.t}\t${e.code}${e.deviceId !== undefined ? `@${e.deviceId}` : ''}`;

export interface RunOptions {
  /** Keep every snapshot for `ctx.history` (default true; disable for very long fuzz runs). */
  readonly keepHistory?: boolean;
  /** Fail the run if any timeline action is rejected (default true; fuzzers opt out). */
  readonly failOnRejectedActions?: boolean;
}

export function runScenario(
  def: ScenarioDef,
  factory: SimulationFactory,
  opts: RunOptions = {},
): ScenarioResult {
  const keepHistory = opts.keepHistory ?? true;
  const duration = scenarioDuration(def);
  const sim = factory({
    topology: def.topology,
    options: def.options ?? {},
    ...(def.versions !== undefined ? { versions: def.versions } : {}),
    seed: def.seed ?? DEFAULT_SEED,
  });

  const failures: ExpectationFailure[] = [];
  const failedAlways = new Set<number>();
  const pendingAt = new Set<number>();
  def.expect.forEach((e, i) => {
    if ('at' in e) pendingAt.add(i);
  });

  const events: SimEvent[] = [];
  const seen = new Set<number>();
  const history: Snapshot[] = [];
  const absorb = (s: Snapshot): void => {
    for (const e of s.events) {
      if (seen.has(e.seq)) continue;
      seen.add(e.seq);
      events.push(e);
    }
    if (keepHistory) history.push(s);
    else history.splice(0, history.length, s);
  };

  const check = (s: Snapshot): void => {
    const ctx: ScenarioContext = { now: s.simTime, events, history };
    def.expect.forEach((e, i) => {
      const due = 'at' in e ? e.at === s.simTime : !failedAlways.has(i);
      if (!due) return;
      let ok: boolean;
      let reason = 'predicate returned false';
      try {
        ok = evaluate(e.that, s, ctx);
      } catch (err) {
        ok = false;
        reason = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      if ('at' in e) pendingAt.delete(i);
      if (ok) return;
      if (!('at' in e)) failedAlways.add(i);
      failures.push({ label: e.label, kind: 'at' in e ? 'at' : 'always', t: s.simTime, reason });
    });
  };

  const steps = [...def.timeline].sort((a, b) => a.at - b.at);
  let next = 0;
  let s = sim.getSnapshot();
  absorb(s);
  const start = s.simTime;
  let ticks = 0;
  for (;;) {
    check(s);
    if (s.simTime >= duration) break;
    while (next < steps.length && (steps[next]?.at ?? Number.POSITIVE_INFINITY) <= s.simTime) {
      const step = steps[next];
      if (step) sim.applyAction(step.action);
      next++;
    }
    const prev = s.simTime;
    s = sim.tick(1);
    ticks++;
    if (s.simTime !== prev + 1) {
      throw new Error(`simulation advanced from t=${prev} to t=${s.simTime} on a single tick`);
    }
    absorb(s);
  }

  for (const i of pendingAt) {
    const e = def.expect[i];
    if (e && 'at' in e) {
      const why = e.at < start ? `before the first snapshot (t=${start})` : `after t=${duration}`;
      failures.push({ label: e.label, kind: 'at', t: e.at, reason: `never evaluated: due ${why}` });
    }
  }
  if (next < steps.length) {
    failures.push({
      label: `timeline step at t=${steps[next]?.at} never applied`,
      kind: 'at',
      t: steps[next]?.at ?? duration,
      reason: `scenario ends at t=${duration}`,
    });
  }

  // A rejected timeline action means the scenario never did what it says (e.g. an unknown action
  // kind): fail loudly instead of passing on an unchanged simulation.
  for (const e of opts.failOnRejectedActions === false ? [] : events) {
    if (e.code !== 'action.rejected') continue;
    failures.push({
      label: 'timeline action rejected',
      kind: 'at',
      t: e.t,
      reason: e.text,
    });
  }

  const log = sim.eventLog();
  return {
    failures,
    eventCodes: (log.length > 0 ? log : events)
      .filter((e) => e.severity !== 'debug')
      .map(goldenCode),
    final: s,
    ticks,
  };
}
