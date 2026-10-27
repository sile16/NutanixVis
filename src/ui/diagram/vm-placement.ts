/**
 * Draw VMs where they actually run (pure). Topology parents are static, but AHV HA restarts a VM on
 * another host (its view field `host` changes). Each moved VM is re-parented to its current host and
 * given a slot in a row just above that host's own VMs, so the host card grows upward instead of
 * overlapping its neighbors.
 */
import type { DeviceView } from '../../engine/types';
import type { LayoutMap } from './layout';

const GAP = 8;
const DEFAULT_BOX = { w: 88, h: 36 };

export interface PlacedView {
  readonly devices: Readonly<Record<string, DeviceView>>;
  readonly layout: LayoutMap;
  /** VM id → host it was moved to (for labels). */
  readonly moved: ReadonlyMap<string, string>;
}

export function relocateVms(
  devices: Readonly<Record<string, DeviceView>>,
  layout: LayoutMap,
): PlacedView {
  const moved = new Map<string, string>();
  for (const d of Object.values(devices)) {
    if (d.kind !== 'vm') continue;
    const host = d.fields.host;
    if (typeof host !== 'string' || host === d.parent) continue;
    if (devices[host]?.kind !== 'ahv-host') continue;
    moved.set(d.id, host);
  }
  if (moved.size === 0) return { devices, layout, moved };

  const outDevices: Record<string, DeviceView> = { ...devices };
  const outLayout: Record<string, LayoutMap[string]> = { ...layout };
  const slotsUsed = new Map<string, number>();

  for (const [vmId, host] of [...moved].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const vm = devices[vmId];
    if (!vm) continue;
    outDevices[vmId] = { ...vm, parent: host };
    // Anchor on the target host's own (topology) VMs; fall back to the VM's previous box.
    const own = Object.values(devices)
      .filter((d) => d.kind === 'vm' && d.parent === host && !moved.has(d.id))
      .map((d) => layout[d.id])
      .filter((b): b is NonNullable<typeof b> => b !== undefined);
    const prev = layout[vmId];
    const w = prev?.w ?? DEFAULT_BOX.w;
    const h = prev?.h ?? DEFAULT_BOX.h;
    const slot = slotsUsed.get(host) ?? 0;
    slotsUsed.set(host, slot + 1);
    if (own.length > 0) {
      const left = Math.min(...own.map((b) => b.x));
      const top = Math.min(...own.map((b) => b.y));
      outLayout[vmId] = { x: left + slot * (w + GAP), y: top - h - GAP, w, h };
    } else if (prev) {
      outLayout[vmId] = { ...prev, y: prev.y - (slot + 1) * (h + GAP) };
    }
  }
  return { devices: outDevices, layout: outLayout, moved };
}
