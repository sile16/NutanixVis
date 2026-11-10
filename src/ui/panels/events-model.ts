/**
 * Event log helpers (pure): filtering and causal chains (SPEC §5.6).
 *
 * `SimEvent` has no `id` field in the contract; `TickContext.emit` returns an id that other
 * events use as a `causeId`. Until the contract gains `SimEvent.id`, the UI assumes the id is
 * `e<seq>` (the mock simulation's convention). See the stream B report.
 */
import type { Severity, SimEvent, Snapshot } from '../../engine/types';

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

type Devices = Snapshot['devices'];
type Links = Snapshot['links'];

/**
 * A device id as a name a reader can place: a NIC with its host (`Node 1 eth2`), a CVM interface
 * with its CVM (`CVM 1 CVM-IP A`), a FlashArray interface with its controller and port
 * (`CT0 eth10 (VLAN 10)`); anything else by its label.
 */
const own = <T>(o: Readonly<Record<string, T>>, k: string): T | undefined =>
  Object.hasOwn(o, k) ? o[k] : undefined;

export function deviceName(devices: Devices, id: string): string {
  const d = own(devices, id);
  if (!d) return id;
  const parent = d.parent ? devices[d.parent] : undefined;
  // An array interface on a port (under a controller); the floating VIP sits on the array itself.
  if (d.kind === 'fa-interface' && parent?.kind === 'nic') {
    const ct = parent.parent ? devices[parent.parent] : undefined;
    return `${ct ? `${ct.label} ` : ''}${parent.label} (${d.label})`;
  }
  if ((d.kind === 'nic' || d.kind === 'cvm-interface') && parent)
    return `${parent.label} ${d.label}`;
  return d.label;
}

/** A cable id as `A ↔ B` (its two end devices), or null if it is not a known cable. */
export function linkName(devices: Devices, links: Links, id: string): string | null {
  const l = own(links, id);
  return l ? `${deviceName(devices, l.a.device)} ↔ ${deviceName(devices, l.b.device)}` : null;
}

/** An NVMe path id (`<cvm-interface>~<fa-interface>`) as `CVM-IP A → CT0 eth10 (VLAN 10)`. */
export function pathName(devices: Devices, id: string): string | null {
  const [local, remote, extra] = id.split('~');
  if (!local || !remote || extra !== undefined || !own(devices, local) || !own(devices, remote)) {
    return null;
  }
  return `${own(devices, local)?.label ?? local} → ${deviceName(devices, remote)}`;
}

const ID_TOKEN = /[A-Za-z0-9][A-Za-z0-9._~-]*[A-Za-z0-9]/g;

/**
 * Event text with the simulator's ids (devices, cables, NVMe paths) replaced by readable names.
 * Ids the snapshot does not know (vDisk ids, codes) are left as they are.
 */
export function readableText(text: string, devices: Devices, links: Links): string {
  return text.replace(ID_TOKEN, (tok) => {
    if (tok.includes('~')) return pathName(devices, tok) ?? tok;
    if (own(devices, tok) && (tok.includes('.') || tok.includes('-')))
      return deviceName(devices, tok);
    return linkName(devices, links, tok) ?? tok;
  });
}
