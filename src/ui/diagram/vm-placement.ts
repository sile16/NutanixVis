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
  /** VM id → its topology host, for every moved VM ("restarted from Node N"). */
  readonly movedFrom: ReadonlyMap<string, string>;
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
  const movedFrom = new Map<string, string>();
  for (const id of moved.keys()) {
    const from = devices[id]?.parent;
    if (from) movedFrom.set(id, from);
  }
  if (moved.size === 0) return { devices, layout, moved, movedFrom };

  const outDevices: Record<string, DeviceView> = { ...devices };
  const outLayout: Record<string, LayoutMap[string]> = { ...layout };
  const slotsUsed = new Map<string, number>();

  for (const [vmId, host] of [...moved].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const vm = devices[vmId];
    if (!vm) continue;
    outDevices[vmId] = { ...vm, parent: host };
    // Anchor on the target host's own (topology) VMs; without any, on the host's other leaves.
    const boxes = (pick: (d: DeviceView) => boolean) =>
      Object.values(devices)
        .filter((d) => d.id !== vmId && !moved.has(d.id) && pick(d))
        .map((d) => layout[d.id])
        .filter((b): b is NonNullable<typeof b> => b !== undefined);
    const ownVms = boxes((d) => d.kind === 'vm' && d.parent === host);
    const hostLeaves = boxes((d) => isUnder(devices, d.id, host));
    const anchor = ownVms.length > 0 ? ownVms : hostLeaves;
    const prev = layout[vmId];
    const w = prev?.w ?? DEFAULT_BOX.w;
    const h = prev?.h ?? DEFAULT_BOX.h;
    const slot = slotsUsed.get(host) ?? 0;
    slotsUsed.set(host, slot + 1);
    if (anchor.length > 0) {
      // Rows no wider than the host's current contents, stacked upward: the card grows up, not
      // sideways into its neighbor.
      const span =
        Math.max(...hostLeaves.map((b) => b.x + (b.w ?? 0))) - Math.min(...anchor.map((b) => b.x));
      const perRow = Math.max(1, ownVms.length, Math.floor((span + GAP) / (w + GAP)));
      const left = Math.min(...anchor.map((b) => b.x));
      const top = Math.min(...anchor.map((b) => b.y));
      const col = slot % perRow;
      const row = Math.floor(slot / perRow);
      outLayout[vmId] = { x: left + col * (w + GAP), y: top - (row + 1) * (h + GAP), w, h };
    } else if (prev) {
      outLayout[vmId] = { ...prev, y: prev.y - (slot + 1) * (h + GAP) };
    }
  }
  return { devices: outDevices, layout: outLayout, moved, movedFrom };
}

function isUnder(devices: Readonly<Record<string, DeviceView>>, id: string, ancestor: string) {
  for (let cur = devices[id]?.parent; cur !== undefined; cur = devices[cur]?.parent) {
    if (cur === ancestor) return true;
  }
  return false;
}

const VIP_H = 16;
const VIP_MIN_W = 190;

/**
 * Draw a floating FlashArray IP (the management VIP, `fa.vir0`) inside the controller that
 * currently hosts it: its `nic` view field follows the primary through a failover. It gets its own
 * row below that controller's ports, so it never sits on top of the other controller's header.
 */
export function relocateFloatingIps(
  devices: Readonly<Record<string, DeviceView>>,
  layout: LayoutMap,
): { devices: Readonly<Record<string, DeviceView>>; layout: LayoutMap } {
  const floating = Object.values(devices).filter(
    (d) => d.kind === 'fa-interface' && d.fields.floating === true,
  );
  if (floating.length === 0) return { devices, layout };
  const outDevices: Record<string, DeviceView> = { ...devices };
  const outLayout: Record<string, LayoutMap[string]> = { ...layout };
  const slots = new Map<string, number>();
  for (const vip of floating.sort((a, b) => a.id.localeCompare(b.id))) {
    const nic = vip.fields.nic;
    if (typeof nic !== 'string') continue;
    let ctl: string | undefined = nic;
    while (ctl !== undefined && devices[ctl]?.kind !== 'fa-controller') ctl = devices[ctl]?.parent;
    if (ctl === undefined) continue;
    const leaves = Object.values(devices)
      .filter((d) => d.id !== vip.id && isUnder(devices, d.id, ctl))
      .map((d) => layout[d.id])
      .filter((b): b is NonNullable<typeof b> => b !== undefined);
    if (leaves.length === 0) continue;
    const left = Math.min(...leaves.map((b) => b.x));
    const bottom = Math.max(...leaves.map((b) => b.y + (b.h ?? 0)));
    const prev = layout[vip.id];
    const slot = slots.get(ctl) ?? 0;
    slots.set(ctl, slot + 1);
    const h = prev?.h ?? VIP_H;
    outDevices[vip.id] = { ...vip, parent: ctl };
    outLayout[vip.id] = {
      x: left,
      // Below the port frames (their padding is 6) that hold the controller's interfaces.
      y: bottom + 6 + GAP + slot * (h + GAP),
      w: Math.max(prev?.w ?? 0, VIP_MIN_W),
      h,
    };
  }
  return { devices: outDevices, layout: outLayout };
}
