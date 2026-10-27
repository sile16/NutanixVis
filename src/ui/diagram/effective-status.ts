/**
 * Effective display status (pure). A failed host takes its NICs, vswitches, CVM, interfaces and
 * disks with it, but a child's own view may still read `healthy` or `offline` (its own admin
 * state). The diagram must never draw a part of a failed device as healthy-looking, so:
 *
 * - a device whose view says `down: true` is drawn failed (engine contract: `downReason` says why);
 * - otherwise a device under a `failed` ancestor is drawn failed, and one under an `offline`
 *   (powered-off) ancestor that still reads healthy is drawn offline;
 * - a cable is drawn down when the device at either end is drawn failed or offline.
 */
import type { DeviceStatus, DeviceView, LinkView } from '../../engine/types';

export interface EffectiveDevice extends DeviceView {
  /** Why the device is drawn down when its own status says otherwise (tooltip). */
  readonly downReason?: string;
}

const DOWN: ReadonlySet<DeviceStatus> = new Set(['failed', 'offline']);

export function effectiveDevices(
  devices: Readonly<Record<string, DeviceView>>,
): Readonly<Record<string, EffectiveDevice>> {
  const memo = new Map<string, EffectiveDevice>();
  // A VM belongs to the host it runs on now (AHV HA restarts move it), not its topology parent.
  const parentOf = (d: DeviceView): string | undefined => {
    const host = d.kind === 'vm' ? d.fields.host : undefined;
    return typeof host === 'string' && devices[host] ? host : d.parent;
  };
  const resolve = (id: string, seen: Set<string>): EffectiveDevice | undefined => {
    const cached = memo.get(id);
    if (cached) return cached;
    const d = devices[id];
    if (!d) return undefined;
    let out: EffectiveDevice = d;
    const parent = parentOf(d);
    const reason = typeof d.fields.downReason === 'string' ? d.fields.downReason : undefined;
    if (d.fields.down === true && d.status !== 'failed') {
      out = { ...d, status: 'failed', ...(reason ? { downReason: reason } : {}) };
    } else if (parent !== undefined && !seen.has(parent) && d.status !== 'failed') {
      seen.add(id);
      const p = resolve(parent, seen);
      if (p?.status === 'failed') {
        out = { ...d, status: 'failed', downReason: p.downReason ?? `${p.label} failed` };
      } else if (p?.status === 'offline' && !DOWN.has(d.status)) {
        out = { ...d, status: 'offline', downReason: p.downReason ?? `${p.label} is off` };
      }
    }
    memo.set(id, out);
    return out;
  };
  const result: Record<string, EffectiveDevice> = {};
  for (const id of Object.keys(devices)) {
    const e = resolve(id, new Set());
    if (e) result[id] = e;
  }
  return result;
}

/** A cable is drawn down if its own status is down or either end device is drawn down. */
export function effectiveLinkStatus(
  link: LinkView,
  devices: Readonly<Record<string, DeviceView>>,
): LinkView['status'] {
  if (link.status === 'down') return 'down';
  const a = devices[link.a.device]?.status;
  const b = devices[link.b.device]?.status;
  return (a && DOWN.has(a)) || (b && DOWN.has(b)) ? 'down' : 'up';
}
