/**
 * Event log helpers (pure): filtering and causal chains (SPEC §5.6).
 *
 * `SimEvent` has no `id` field in the contract; `TickContext.emit` returns an id that other
 * events use as a `causeId`. Until the contract gains `SimEvent.id`, the UI assumes the id is
 * `e<seq>` (the mock simulation's convention). See the stream B report.
 */
import type { Severity, SimEvent } from '../../engine/types';

export const SEVERITIES: readonly Severity[] = ['debug', 'info', 'warn', 'error', 'critical'];

export const eventId = (e: SimEvent): string => {
  const withId = e as SimEvent & { readonly id?: unknown };
  return typeof withId.id === 'string' ? withId.id : `e${e.seq}`;
};

export interface EventFilter {
  readonly minSeverity: Severity;
  /** Only events about this device or its descendants (null = all). */
  readonly deviceId: string | null;
}

export function filterEvents(
  log: readonly SimEvent[],
  filter: EventFilter,
  isWithin: (deviceId: string, ancestor: string) => boolean = (d, a) => d === a,
): SimEvent[] {
  const min = SEVERITIES.indexOf(filter.minSeverity);
  return log.filter((e) => {
    if (SEVERITIES.indexOf(e.severity) < min) return false;
    if (filter.deviceId === null) return true;
    return e.deviceId !== undefined && isWithin(e.deviceId, filter.deviceId);
  });
}

export function indexEvents(log: readonly SimEvent[]): Map<string, SimEvent> {
  return new Map(log.map((e) => [eventId(e), e]));
}

/**
 * The causal chain ending at `event`, root first. Follows the first resolvable cause at each
 * step (events usually have one cause) and stops on cycles or unknown ids.
 */
export function causalChain(event: SimEvent, index: ReadonlyMap<string, SimEvent>): SimEvent[] {
  const chain: SimEvent[] = [event];
  const seen = new Set([eventId(event)]);
  let cur = event;
  for (;;) {
    const cause = cur.causeIds.map((c) => index.get(c)).find((e) => e && !seen.has(eventId(e)));
    if (!cause) break;
    chain.unshift(cause);
    seen.add(eventId(cause));
    cur = cause;
  }
  return chain;
}
