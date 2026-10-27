/**
 * Append-only event log (SPEC §5.6). Every event gets a sequence number and an id (`e<seq>`)
 * that later events and messages cite in `causeIds`, so the Explain panel can walk the chain.
 */
import type { EventDraft, SimEvent, SimTime } from './types';

const EVENT_ID = /^e(\d+)$/;

export function eventId(seq: number): string {
  return `e${seq}`;
}

/** Sequence number of an event id, or `undefined` if `id` is not an event id (e.g. a message). */
export function eventSeq(id: string): number | undefined {
  const m = EVENT_ID.exec(id);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

export class EventLog {
  private readonly items: SimEvent[] = [];

  get size(): number {
    return this.items.length;
  }

  /**
   * Append an event at time `t`; returns its id. Event-id causes must already exist (causes
   * always precede effects). Non-event causes (message ids) are kept as-is.
   */
  append(t: SimTime, draft: EventDraft): string {
    const seq = this.items.length + 1;
    for (const c of draft.causeIds) {
      const cs = eventSeq(c);
      if (cs !== undefined && (cs < 1 || cs >= seq)) {
        throw new Error(`event '${draft.code}': cause ${c} does not precede it`);
      }
    }
    const ev: SimEvent = {
      seq,
      t,
      severity: draft.severity,
      ...(draft.deviceId === undefined ? {} : { deviceId: draft.deviceId }),
      code: draft.code,
      text: draft.text,
      causeIds: Object.freeze([...draft.causeIds]),
      cite: Object.freeze([...draft.cite]),
      ...(draft.confidence === undefined ? {} : { confidence: draft.confidence }),
    };
    this.items.push(Object.freeze(ev));
    return eventId(seq);
  }

  all(): readonly SimEvent[] {
    return this.items;
  }

  /** Events with `seq > afterSeq`, in order. */
  since(afterSeq: number): readonly SimEvent[] {
    return this.items.slice(afterSeq);
  }

  get(id: string): SimEvent | undefined {
    const seq = eventSeq(id);
    return seq === undefined ? undefined : this.items[seq - 1];
  }

  /** The event and all its transitive event causes, oldest first. */
  causalChain(id: string): readonly SimEvent[] {
    const seen = new Set<number>();
    const stack = [id];
    while (stack.length > 0) {
      const ev = this.get(stack.pop() ?? '');
      if (!ev || seen.has(ev.seq)) continue;
      seen.add(ev.seq);
      stack.push(...ev.causeIds);
    }
    return [...seen].sort((a, b) => a - b).flatMap((s) => this.items[s - 1] ?? []);
  }
}
