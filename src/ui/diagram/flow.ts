/**
 * Snapshot + layout → React Flow nodes and edges. Pure data mapping: positions, sizes and port
 * handles come from our own layout (`layout.ts`) and paths from `geometry.ts`, so React Flow is
 * only the renderer.
 */
import { type Edge, type Node, type NodeHandle, Position } from '@xyflow/react';
import type { LinkView } from '../../engine/types';
import { type EffectiveDevice, effectiveLinkStatus } from './effective-status';
import type { LinkGeometry, Point, Side } from './geometry';
import { type DiagramLayout, groupFrame } from './layout';
import type { PathUsage } from './path-usage';

export type NodeKind =
  | 'switch'
  | 'host'
  | 'cvm'
  | 'vm'
  | 'array'
  | 'controller'
  | 'nic'
  | 'iface'
  | 'vswitch'
  | 'disk'
  | 'generic';

const KIND_TO_TYPE: Readonly<Record<string, NodeKind>> = {
  switch: 'switch',
  'ahv-host': 'host',
  cvm: 'cvm',
  vm: 'vm',
  'fa-array': 'array',
  'fa-controller': 'controller',
  nic: 'nic',
  'fa-interface': 'iface',
  'cvm-interface': 'iface',
  'host-interface': 'iface',
  vswitch: 'vswitch',
  // The engine's network view names a host virtual switch `bond` (docs/view-fields.md: `vswitch`).
  bond: 'vswitch',
  disk: 'disk',
};

export const nodeTypeFor = (kind: string): NodeKind => KIND_TO_TYPE[kind] ?? 'generic';

export interface PortHandle {
  readonly id: string;
  readonly side: Side;
  /** Anchor relative to the node's top-left. */
  readonly x: number;
  readonly y: number;
}

export type DeviceNodeData = {
  /** The device as drawn: status may be the effective one (see `effective-status.ts`). */
  device: EffectiveDevice;
  /** AHV HA restarted this VM away from its topology host: that host's label. */
  restartedFrom: string | null;
  isGroup: boolean;
  frame: { pad: number; header: number };
  ports: readonly PortHandle[];
  dim: boolean;
  inPath: boolean;
  /** Bond-utilization overlay text for NICs (e.g. "50%"). */
  utilLabel: string | null;
};
export type DeviceNode = Node<DeviceNodeData, NodeKind>;

export type CableEdgeData = {
  link: LinkView;
  pathD: string;
  mid: Point;
  /** Highlight color (reduced-motion traffic highlight or path view), or null. */
  glow: string | null;
  /** Glow strength: fades with how long ago the link last carried traffic. */
  glowOpacity: number;
  dropped: boolean;
  dim: boolean;
  inPath: boolean;
  label: string | null;
};
export type CableEdge = Edge<CableEdgeData, 'cable'>;

const POSITION: Readonly<Record<Side, Position>> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

/**
 * React Flow handle bounds whose computed endpoint equals our anchor (width = height = 1).
 * Each port is declared as both a source and a target: on the first render React Flow still has
 * its default `ConnectionMode.Strict` (our `Loose` prop is synced in an effect), so a source-only
 * handle at a cable's `b` end fails the lookup and logs error 008 for every cable.
 */
function handleBounds(p: PortHandle, type: 'source' | 'target'): NodeHandle {
  const base = {
    id: p.id,
    type,
    position: POSITION[p.side],
    width: 1,
    height: 1,
  };
  switch (p.side) {
    case 'top':
      return { ...base, x: p.x - 0.5, y: p.y };
    case 'bottom':
      return { ...base, x: p.x - 0.5, y: p.y - 1 };
    case 'left':
      return { ...base, x: p.x, y: p.y - 0.5 };
    default:
      return { ...base, x: p.x - 1, y: p.y - 0.5 };
  }
}

export interface NodeBuildOptions {
  readonly selectedId: string | null;
  readonly pathUsage: PathUsage | null;
  readonly utilLabels: ReadonlyMap<string, string>;
  readonly draggable: boolean;
  /** VM id → label of the host AHV HA restarted it away from. */
  readonly restartedFrom?: ReadonlyMap<string, string>;
}

export function buildNodes(
  devices: Readonly<Record<string, EffectiveDevice>>,
  dl: DiagramLayout,
  opts: NodeBuildOptions,
): DeviceNode[] {
  const portsByDevice = new Map<string, PortHandle[]>();
  for (const a of dl.anchors.values()) {
    const list = portsByDevice.get(a.device) ?? [];
    list.push({ id: a.port, side: a.side, x: a.rel.x, y: a.rel.y });
    portsByDevice.set(a.device, list);
  }
  const nodes: DeviceNode[] = [];
  for (const id of dl.order) {
    const placed = dl.placed.get(id);
    const device = devices[id];
    if (!placed || !device) continue;
    const restartedFrom = opts.restartedFrom?.get(id) ?? null;
    const parentRect = placed.parent ? dl.placed.get(placed.parent)?.rect : undefined;
    const ports = portsByDevice.get(id) ?? [];
    const { w, h } = placed.rect;
    const inPath = opts.pathUsage?.deviceIds.has(id) ?? false;
    const node: DeviceNode = {
      id,
      type: nodeTypeFor(device.kind),
      position: {
        x: placed.rect.x - (parentRect?.x ?? 0),
        y: placed.rect.y - (parentRect?.y ?? 0),
      },
      width: w,
      height: h,
      measured: { width: w, height: h },
      // zIndexMode="manual": nested devices stack by depth; cables (z 0) run beneath them all.
      zIndex: placed.depth + 1,
      handles: ports.flatMap((p) => [handleBounds(p, 'source'), handleBounds(p, 'target')]),
      selected: opts.selectedId === id,
      draggable: opts.draggable,
      connectable: false,
      deletable: false,
      ariaLabel: `${device.label} (${device.kind}), ${device.status}${
        device.downReason ? ` (${device.downReason})` : ''
      }${restartedFrom ? `, restarted from ${restartedFrom}` : ''}`,
      data: {
        device,
        restartedFrom,
        isGroup: placed.isGroup,
        frame: groupFrame(device.kind),
        ports,
        dim: opts.pathUsage !== null && !inPath && !placed.isGroup,
        inPath: inPath && opts.pathUsage?.vmId !== id,
        utilLabel: opts.utilLabels.get(id) ?? null,
      },
    };
    if (placed.parent) node.parentId = placed.parent;
    nodes.push(node);
  }
  return nodes;
}

export interface EdgeBuildOptions {
  readonly selectedId: string | null;
  readonly pathUsage: PathUsage | null;
  /** Per-link activity highlight: dominant category color, opacity (recency) and drop marker. */
  readonly glow: ReadonlyMap<string, { color: string; dropped: boolean; opacity: number }>;
  readonly labels: ReadonlyMap<string, string>;
}

export function buildEdges(
  links: Readonly<Record<string, LinkView>>,
  devices: Readonly<Record<string, EffectiveDevice>>,
  geometries: ReadonlyMap<string, LinkGeometry>,
  opts: EdgeBuildOptions,
): CableEdge[] {
  const edges: CableEdge[] = [];
  for (const raw of Object.values(links)) {
    const g = geometries.get(raw.id);
    if (!g) continue;
    // A cable to a failed device is drawn down even before the engine reports it.
    const status = effectiveLinkStatus(raw, devices);
    const link = status === raw.status ? raw : { ...raw, status };
    const inPath = opts.pathUsage?.linkIds.has(link.id) ?? false;
    const glow = opts.glow.get(link.id);
    edges.push({
      id: link.id,
      type: 'cable',
      source: link.a.device,
      sourceHandle: link.a.port,
      target: link.b.device,
      targetHandle: link.b.port,
      selected: opts.selectedId === link.id,
      deletable: false,
      zIndex: 0,
      ariaLabel: `Cable ${link.id}, ${link.status}`,
      data: {
        link,
        pathD: g.pathD,
        mid: g.pointAt(0.5),
        glow: glow?.color ?? null,
        glowOpacity: glow?.opacity ?? 0,
        dropped: glow?.dropped ?? false,
        dim: opts.pathUsage !== null && !inPath,
        inPath,
        label: opts.labels.get(link.id) ?? null,
      },
    });
  }
  return edges;
}
