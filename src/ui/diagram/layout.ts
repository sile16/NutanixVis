/**
 * Diagram layout (pure): absolute device rectangles, computed group bounds and port anchors.
 *
 * Conventions (shared with stream D's `Topology['layout']`):
 * - Layout entries are **absolute** flow coordinates. Leaves carry `x, y` and optionally `w, h`.
 * - A device with children is a group. React Flow parents don't auto-fit their children
 *   (SPEC §3), so group bounds are computed here: children bbox + padding + a header band.
 * - Devices missing from the layout are flowed into a row below their placed siblings, so a
 *   partial layout still renders.
 * - Every link end becomes a port anchor on the device side facing its peer. Ports on the same
 *   side are spread evenly and ordered by peer position to reduce crossings.
 */
import type { DeviceView, LinkView } from '../../engine/types';
import type { Anchor, Rect, Side } from './geometry';

/** Same shape as `Topology['layout'][id]` (Zod infers `w?: number | undefined`). */
export interface LayoutEntry {
  readonly x: number;
  readonly y: number;
  readonly w?: number | undefined;
  readonly h?: number | undefined;
}
export type LayoutMap = Readonly<Record<string, LayoutEntry>>;

export interface PlacedDevice {
  readonly id: string;
  readonly rect: Rect;
  readonly depth: number;
  readonly isGroup: boolean;
  readonly parent: string | undefined;
}

export interface PortAnchor extends Anchor {
  readonly device: string;
  readonly port: string;
  readonly linkId: string;
  /** Anchor relative to the device's top-left corner. */
  readonly rel: { readonly x: number; readonly y: number };
}

export interface DiagramLayout {
  readonly placed: ReadonlyMap<string, PlacedDevice>;
  /** Device ids, parents before children (React Flow wants parents first). */
  readonly order: readonly string[];
  readonly anchors: ReadonlyMap<string, PortAnchor>;
  readonly bounds: Rect;
}

export const portKey = (device: string, port: string): string => `${device}#${port}`;

const DEFAULT_SIZE: Readonly<Record<string, { w: number; h: number }>> = {
  switch: { w: 400, h: 60 },
  'ahv-host': { w: 240, h: 160 },
  cvm: { w: 104, h: 36 },
  vm: { w: 88, h: 36 },
  vswitch: { w: 140, h: 26 },
  nic: { w: 56, h: 28 },
  'fa-array': { w: 300, h: 120 },
  'fa-controller': { w: 200, h: 80 },
  'fa-interface': { w: 96, h: 22 },
  'cvm-interface': { w: 46, h: 22 },
  disk: { w: 44, h: 20 },
};
const FALLBACK_SIZE = { w: 100, h: 40 };

/** Inner padding and header band for group frames, by device kind. */
export const GROUP_FRAME: Readonly<Record<string, { pad: number; header: number }>> = {
  'ahv-host': { pad: 12, header: 28 },
  'fa-array': { pad: 12, header: 30 },
  'fa-controller': { pad: 8, header: 26 },
  cvm: { pad: 6, header: 22 },
  nic: { pad: 6, header: 20 },
};
const FALLBACK_FRAME = { pad: 10, header: 26 };

const GAP = 10;
const ROOT_GAP = 60;

export const defaultSize = (kind: string) => DEFAULT_SIZE[kind] ?? FALLBACK_SIZE;
export const groupFrame = (kind: string) => GROUP_FRAME[kind] ?? FALLBACK_FRAME;

const union = (rects: readonly Rect[]): Rect | null => {
  if (rects.length === 0) return null;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/** Logical devices that hold cluster-wide state; shown in panels, not drawn on the diagram. */
const LOGICAL_KINDS: ReadonlySet<string> = new Set(['nutanix-cluster']);

export function childrenIndex(
  devices: Readonly<Record<string, DeviceView>>,
): Map<string | undefined, string[]> {
  const kids = new Map<string | undefined, string[]>();
  for (const d of Object.values(devices)) {
    if (LOGICAL_KINDS.has(d.kind)) continue;
    const parent = d.parent !== undefined && devices[d.parent] ? d.parent : undefined;
    const list = kids.get(parent) ?? [];
    list.push(d.id);
    kids.set(parent, list);
  }
  for (const list of kids.values()) list.sort();
  return kids;
}

export function computeLayout(
  devices: Readonly<Record<string, DeviceView>>,
  links: Readonly<Record<string, LinkView>>,
  layout: LayoutMap,
): DiagramLayout {
  const kids = childrenIndex(devices);
  const placed = new Map<string, PlacedDevice>();

  const anchoredMemo = new Map<string, boolean>();
  const anchored = (id: string): boolean => {
    const memo = anchoredMemo.get(id);
    if (memo !== undefined) return memo;
    const v = layout[id] !== undefined || (kids.get(id) ?? []).some(anchored);
    anchoredMemo.set(id, v);
    return v;
  };

  const flowRow = (
    ids: readonly string[],
    start: { x: number; y: number },
    depth: number,
    parent: string | undefined,
    wrapAt: number,
    gap: number,
  ): Rect[] => {
    const out: Rect[] = [];
    let cx = start.x;
    let cy = start.y;
    let rowH = 0;
    for (const id of ids) {
      const r = place(id, depth, parent, { x: cx, y: cy });
      if (cx > start.x && r.x + r.w - start.x > wrapAt) {
        // wrap: re-place on the next row
        cx = start.x;
        cy += rowH + gap;
        rowH = 0;
        placed.delete(id);
        const r2 = place(id, depth, parent, { x: cx, y: cy });
        out.push(r2);
        cx += r2.w + gap;
        rowH = Math.max(rowH, r2.h);
        continue;
      }
      out.push(r);
      cx += r.w + gap;
      rowH = Math.max(rowH, r.h);
    }
    return out;
  };

  /** Translate a subtree that was placed relative to an origin. */
  const shift = (id: string, dx: number, dy: number) => {
    const p = placed.get(id);
    if (!p) return;
    placed.set(id, { ...p, rect: { ...p.rect, x: p.rect.x + dx, y: p.rect.y + dy } });
    for (const k of kids.get(id) ?? []) shift(k, dx, dy);
  };

  function place(
    id: string,
    depth: number,
    parent: string | undefined,
    origin: { x: number; y: number },
  ): Rect {
    const d = devices[id];
    const kind = d?.kind ?? '';
    const entry = layout[id];
    const children = kids.get(id) ?? [];
    let rect: Rect;
    if (children.length === 0) {
      const size = defaultSize(kind);
      rect = {
        x: entry?.x ?? origin.x,
        y: entry?.y ?? origin.y,
        w: entry?.w ?? size.w,
        h: entry?.h ?? size.h,
      };
    } else {
      const { pad, header } = groupFrame(kind);
      const base = entry ? { x: entry.x, y: entry.y } : origin;
      const fixed = children.filter(anchored).map((k) => place(k, depth + 1, id, origin));
      const fixedBox = union(fixed);
      const floating = children.filter((k) => !anchored(k));
      const start = fixedBox
        ? { x: fixedBox.x, y: fixedBox.y + fixedBox.h + GAP }
        : { x: base.x + pad, y: base.y + header + pad };
      const floated = flowRow(floating, start, depth + 1, id, Math.max(fixedBox?.w ?? 0, 300), GAP);
      const inner = union([...fixed, ...floated]) ?? { x: start.x, y: start.y, w: 0, h: 0 };
      let r: Rect = {
        x: inner.x - pad,
        y: inner.y - pad - header,
        w: inner.w + 2 * pad,
        h: inner.h + 2 * pad + header,
      };
      if (entry?.w !== undefined && entry.h !== undefined) {
        r = union([r, { x: entry.x, y: entry.y, w: entry.w, h: entry.h }]) ?? r;
      }
      rect = r;
    }
    placed.set(id, { id, rect, depth, isGroup: children.length > 0, parent });
    return rect;
  }

  const roots = kids.get(undefined) ?? [];
  const fixedRoots = roots.filter(anchored).map((id) => place(id, 0, undefined, { x: 0, y: 0 }));
  const box = union(fixedRoots);
  const floatingRoots = roots.filter((id) => !anchored(id));
  if (floatingRoots.length) {
    const start = box ? { x: box.x, y: box.y + box.h + ROOT_GAP } : { x: 0, y: 0 };
    // Place each floating root at the origin, then shift it into the row.
    let cx = start.x;
    for (const id of floatingRoots) {
      const r = place(id, 0, undefined, { x: 0, y: 0 });
      shift(id, cx - r.x, start.y - r.y);
      cx += r.w + ROOT_GAP;
    }
  }

  const order = [...placed.values()]
    .sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))
    .map((p) => p.id);

  const anchors = computeAnchors(links, placed);
  const bounds = union([...placed.values()].map((p) => p.rect)) ?? { x: 0, y: 0, w: 0, h: 0 };
  return { placed, order, anchors, bounds };
}

const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** The side of `r` that faces `peer`. Prefers vertical exits when the peer is above/below. */
export function facingSide(r: Rect, peer: Rect): Side {
  if (peer.y >= r.y + r.h) return 'bottom';
  if (peer.y + peer.h <= r.y) return 'top';
  if (peer.x >= r.x + r.w) return 'right';
  if (peer.x + peer.w <= r.x) return 'left';
  const c = center(r);
  const p = center(peer);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  if (Math.abs(dy) * r.w >= Math.abs(dx) * r.h) return dy >= 0 ? 'bottom' : 'top';
  return dx >= 0 ? 'right' : 'left';
}

export function computeAnchors(
  links: Readonly<Record<string, LinkView>>,
  placed: ReadonlyMap<string, PlacedDevice>,
): Map<string, PortAnchor> {
  interface Pending {
    device: string;
    port: string;
    linkId: string;
    side: Side;
    sortKey: number;
  }
  const bySide = new Map<string, Pending[]>();
  const seen = new Set<string>();
  const sortedLinks = Object.values(links).sort((a, b) => a.id.localeCompare(b.id));
  for (const l of sortedLinks) {
    const ra = placed.get(l.a.device)?.rect;
    const rb = placed.get(l.b.device)?.rect;
    if (!ra || !rb) continue;
    for (const [end, r, peer] of [
      [l.a, ra, rb],
      [l.b, rb, ra],
    ] as const) {
      const key = portKey(end.device, end.port);
      if (seen.has(key)) continue;
      seen.add(key);
      const side = facingSide(r, peer);
      const pc = center(peer);
      const list = bySide.get(`${end.device}|${side}`) ?? [];
      list.push({
        device: end.device,
        port: end.port,
        linkId: l.id,
        side,
        sortKey: side === 'top' || side === 'bottom' ? pc.x : pc.y,
      });
      bySide.set(`${end.device}|${side}`, list);
    }
  }
  const anchors = new Map<string, PortAnchor>();
  for (const list of bySide.values()) {
    list.sort((p, q) => p.sortKey - q.sortKey || p.port.localeCompare(q.port));
    list.forEach((p, i) => {
      const r = placed.get(p.device)?.rect;
      if (!r) return;
      const f = (i + 1) / (list.length + 1);
      let rel: { x: number; y: number };
      switch (p.side) {
        case 'top':
          rel = { x: r.w * f, y: 0 };
          break;
        case 'bottom':
          rel = { x: r.w * f, y: r.h };
          break;
        case 'left':
          rel = { x: 0, y: r.h * f };
          break;
        default:
          rel = { x: r.w, y: r.h * f };
      }
      anchors.set(portKey(p.device, p.port), {
        device: p.device,
        port: p.port,
        linkId: p.linkId,
        side: p.side,
        rel,
        x: r.x + rel.x,
        y: r.y + rel.y,
      });
    });
  }
  return anchors;
}

/**
 * Move device `id` so its top-left lands on `to` (absolute). Groups move by translating every
 * leaf below them; their bounds are recomputed from the children afterwards.
 */
export function moveDevice(
  layout: LayoutMap,
  result: DiagramLayout,
  devices: Readonly<Record<string, DeviceView>>,
  id: string,
  to: { x: number; y: number },
): LayoutMap {
  const p = result.placed.get(id);
  if (!p) return layout;
  const dx = to.x - p.rect.x;
  const dy = to.y - p.rect.y;
  if (dx === 0 && dy === 0) return layout;
  const kids = childrenIndex(devices);
  const next: Record<string, LayoutEntry> = { ...layout };
  const visit = (cur: string) => {
    const children = kids.get(cur) ?? [];
    const placedCur = result.placed.get(cur);
    if (children.length === 0 && placedCur) {
      const r = placedCur.rect;
      next[cur] = { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
      return;
    }
    for (const k of children) visit(k);
  };
  visit(id);
  return next;
}

/** Layout JSON for the dev-only "Copy layout JSON" button: every leaf, rounded, sorted. */
export function exportLayout(result: DiagramLayout): Record<string, LayoutEntry> {
  const out: Record<string, LayoutEntry> = {};
  const leaves = [...result.placed.values()]
    .filter((p) => !p.isGroup)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const p of leaves) {
    out[p.id] = {
      x: Math.round(p.rect.x),
      y: Math.round(p.rect.y),
      w: Math.round(p.rect.w),
      h: Math.round(p.rect.h),
    };
  }
  return out;
}
