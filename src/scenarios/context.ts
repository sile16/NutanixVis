/**
 * Accumulated run state for expectations. `Snapshot.events` only carries the last tick's events,
 * so the runner accumulates events (and snapshots) and hands them to predicates that need history.
 *
 * Bridge until the integrator adopts the proposed `define.ts` change (`that: (s, ctx) => boolean`):
 * `withCtx` wraps a context-aware predicate in a plain `(s) => boolean` the current contract
 * accepts, and registers the full form so `evaluate` (used by the runner) can pass the context.
 * Called without a runner (e.g. by the UI), the wrapper falls back to a one-tick context.
 */
import type { SimEvent, SimTime, Snapshot } from '../engine/types';

export interface ScenarioContext {
  readonly now: SimTime;
  /** Every event since t=0, oldest first, including the current tick's. */
  readonly events: readonly SimEvent[];
  /** Every snapshot since t=0, oldest first; the last element is the current one. */
  readonly history: readonly Snapshot[];
}

export type Predicate = (s: Snapshot) => boolean;
export type CtxPredicate = (s: Snapshot, ctx: ScenarioContext) => boolean;

const full = new WeakMap<Predicate, CtxPredicate>();

export function withCtx(fn: CtxPredicate): Predicate {
  const fallback: Predicate = (s) => fn(s, { now: s.simTime, events: s.events, history: [s] });
  full.set(fallback, fn);
  return fallback;
}

export function evaluate(that: Predicate, s: Snapshot, ctx: ScenarioContext): boolean {
  const withContext = full.get(that);
  return withContext ? withContext(s, ctx) : that(s);
}
