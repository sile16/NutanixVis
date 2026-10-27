/**
 * Cause lookup for the Explain panel's causal chain (SPEC §5.6). Domain state machines notice
 * failures indirectly (a keep-alive goes unanswered, a claim stops being renewed), so they cannot
 * see the event that caused them. This index remembers the latest significant event per device
 * from `ctx.prev.events`, so e.g. `nvme.path.lost` can cite the `device.failed` of the switch its
 * frames were dropped at. Shared by every device of the domain; each event is indexed once.
 */
import { eventId } from '../../engine/events';
import type { SimEvent, Snapshot } from '../../engine/types';

const SIGNIFICANT: ReadonlySet<SimEvent['severity']> = new Set(['warn', 'error', 'critical']);

export class CauseIndex {
  private lastSeq = 0;
  private readonly byDevice = new Map<string, string>();

  /** Index the previous tick's events (idempotent: call from any hook, any number of times). */
  observe(prev: Snapshot): void {
    for (const e of prev.events) {
      if (e.seq <= this.lastSeq) continue;
      this.lastSeq = e.seq;
      if (e.deviceId === undefined) continue;
      if (SIGNIFICANT.has(e.severity) || e.code.startsWith('action.')) {
        this.byDevice.set(e.deviceId, eventId(e.seq));
      }
    }
  }

  /** Latest significant event on the first of `ids` that has one. */
  causeOf(...ids: readonly (string | undefined)[]): string[] {
    for (const id of ids) {
      const ev = id === undefined ? undefined : this.byDevice.get(id);
      if (ev !== undefined) return [ev];
    }
    return [];
  }
}
