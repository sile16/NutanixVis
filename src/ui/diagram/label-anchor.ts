/**
 * Where a cable's speed label sits (pure). A label at the cable's midpoint lands wherever the
 * route bends, often on top of a neighbouring cable or another label. Instead:
 *
 * - a host NIC or array port cable is labeled just outside the frame of the device that owns
 *   the port (the AHV node, the array), on the straight run leaving it, so the labels of sibling
 *   NICs line up side by side;
 * - the switch interconnect is labeled below the gap between the two switches.
 */
import type { DeviceView, LinkView } from '../../engine/types';
import type { LinkGeometry, Point, Rect } from './geometry';
import type { DiagramLayout } from './layout';

export type LabelPlace = 'center' | 'below';

export interface LabelAnchor {
  readonly x: number;
  readonly y: number;
  /** `center`: centered on the point; `below`: hangs below it, centered horizontally. */
  readonly place: LabelPlace;
}

const inside = (p: Point, r: Rect) =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/**
 * The point `clear` px past where the cable leaves `frame`, walking from the end at `fromA`
 * (the source end when true). Falls back to the midpoint when the cable never leaves it.
 */
export function anchorOutside(
  g: LinkGeometry,
  fromA: boolean,
  frame: Rect,
  clear = 12,
): LabelAnchor {
  const mid = g.pointAt(0.5);
  if (g.length <= 0) return { ...mid, place: 'center' };
  const step = 2 / g.length;
  for (let s = 0; s <= 0.5; s += step) {
    const p = g.pointAt(fromA ? s : 1 - s);
    if (!inside(p, frame)) {
      const t = Math.min(0.5, s + clear / g.length);
      return { ...g.pointAt(fromA ? t : 1 - t), place: 'center' };
    }
  }
  return { ...mid, place: 'center' };
}

/** Below the gap between two boxes joined by `g` (the ISL between Switch A and Switch B). */
export function anchorBelow(g: LinkGeometry, a: Rect, b: Rect, gap = 6): LabelAnchor {
  const mid = g.pointAt(0.5);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x: mid.x, y: bottom + gap, place: 'below' };
}

/** The outermost drawn frame that contains `id` (an AHV node, the array), or `id` itself. */
function topFrame(id: string, dl: DiagramLayout): Rect | undefined {
  let cur = dl.placed.get(id);
  while (cur?.parent) {
    const up = dl.placed.get(cur.parent);
    if (!up) break;
    cur = up;
  }
  return cur?.rect;
}

/** Label anchors for every cable between a switch and a port, and for switch-to-switch links. */
export function cableLabelAnchors(
  links: Readonly<Record<string, LinkView>>,
  devices: Readonly<Record<string, DeviceView>>,
  dl: DiagramLayout,
  geometries: ReadonlyMap<string, LinkGeometry>,
): Map<string, LabelAnchor> {
  const out = new Map<string, LabelAnchor>();
  const isSwitch = (id: string) => devices[id]?.kind === 'switch';
  for (const l of Object.values(links)) {
    const g = geometries.get(l.id);
    if (!g) continue;
    const a = l.a.device;
    const b = l.b.device;
    if (isSwitch(a) && isSwitch(b)) {
      const ra = dl.placed.get(a)?.rect;
      const rb = dl.placed.get(b)?.rect;
      if (ra && rb) out.set(l.id, anchorBelow(g, ra, rb));
      continue;
    }
    if (isSwitch(a) === isSwitch(b)) continue;
    const end = isSwitch(a) ? b : a;
    const frame = topFrame(end, dl);
    if (frame) out.set(l.id, anchorOutside(g, end === a, frame));
  }
  return out;
}
