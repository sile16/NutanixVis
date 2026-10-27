/**
 * Accumulated run state for expectations. `Snapshot.events` only carries the last tick's events,
 * so the runner accumulates events (and snapshots) and hands them to predicates that need history.
 *
 * Bridge until the integrator adopts the proposed `define.ts` change (`that: (s, ctx) => boolean`):
 * `withCtx` wraps a context-aware predicate in a plain `(s) => boolean` the current contract
 * accepts, and registers the full form so `evaluate` (used by the runner) can pass the context.
 * Called without a runner (e.g. by the UI), the wrapper falls back to a one-tick context.
 */
import type { Snapshot } from '../engine/types';
import type { Predicate as ContractPredicate, ScenarioContext } from './define';

export type { ScenarioContext } from './define';

/** Snapshot-only predicate (most helpers). Assignable to the contract's `(s, ctx)` predicate. */
export type Predicate = (s: Snapshot) => boolean;
export type CtxPredicate = ContractPredicate;

const full = new WeakMap<Predicate, CtxPredicate>();

/**
 * Wrap a context-aware predicate so it also works where only a snapshot is available (e.g. the
 * UI's guided tour), falling back to a one-tick context. Kept for existing scenario files; new ones
 * may pass `(s, ctx) => …` directly, since the contract now accepts it.
 */
export function withCtx(fn: CtxPredicate): Predicate {
  const fallback: Predicate = (s) => fn(s, { now: s.simTime, events: s.events, history: [s] });
  full.set(fallback, fn);
  return fallback;
}

export function evaluate(that: ContractPredicate, s: Snapshot, ctx: ScenarioContext): boolean {
  const withContext = full.get(that as Predicate);
  return withContext ? withContext(s, ctx) : that(s, ctx);
}
