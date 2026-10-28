/**
 * The topology diagram: React Flow renders device nodes and cables laid out by `layout.ts` and
 * routed by `geometry.ts`; the canvas `PacketOverlay` streams traffic dots on top. The diagram only
 * reads snapshots; user intent goes through the UI store and `useSimControls`.
 */
import {
  Background,
  type ColorMode,
  ConnectionMode,
  Controls,
  type EdgeChange,
  type FitViewOptions,
  type NodeChange,
  Panel,
  ReactFlow,
} from '@xyflow/react';
import { useCallback, useMemo, useState } from 'react';
import type { DeviceView, Snapshot } from '../../engine/types';
import { useSnapshot } from '../store/sim-context';
import { useUi } from '../store/ui-store';
import { glowOpacity } from './activity-window';
import { ContextMenu } from './context-menu';
import { effectiveDevices } from './effective-status';
import { buildEdges, buildNodes, type CableEdge, type DeviceNode } from './flow';
import { computeLinkGeometries, type Point } from './geometry';
import {
  useActivityWindow,
  useLinkFlows,
  usePrefersReducedMotion,
  usePreviousSnapshot,
  useTraceHistory,
} from './hooks';
import { computeLayout, type LayoutMap, moveDevice, portKey } from './layout';
import { LayoutEditPanel } from './layout-edit-panel';
import { Legend } from './legend';
import { LinkHoverCard } from './link-hover-card';
import { PacketOverlay } from './packet-overlay';
import { bondUtilization, computePathUsage } from './path-usage';
import { type DropContext, deadChecker, dropKey, type ReplayContext } from './replay';
import { categoryOrder, isCategoryVisible, trafficStyle } from './traffic';
import { edgeTypes, nodeTypes } from './types';
import { relocateFloatingIps, relocateVms } from './vm-placement';

/** Layout depends only on structure (ids, parents, kinds, cable ends), not on per-tick state. */
function structureKey(devices: Readonly<Record<string, DeviceView>>, s: Snapshot): string {
  const d = Object.values(devices)
    .map((x) => `${x.id}<${x.parent ?? ''}:${x.kind}`)
    .sort()
    .join('|');
  const l = Object.values(s.links)
    .map((x) => `${x.id}=${x.a.device}#${x.a.port}~${x.b.device}#${x.b.port}`)
    .sort()
    .join('|');
  return `${d}//${l}`;
}

/** Keep the bottom-left legend from covering the diagram on fit. */
const FIT_VIEW: FitViewOptions = {
  padding: { top: '16px', right: '16px', left: '16px', bottom: '150px' },
};

export function Diagram({
  baseLayout,
  colorMode,
}: {
  baseLayout: LayoutMap;
  colorMode: ColorMode;
}) {
  const snapshot = useSnapshot();
  const prev = usePreviousSnapshot();
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const openContextMenu = useUi((s) => s.openContextMenu);
  const setHoveredLink = useUi((s) => s.setHoveredLink);
  const layoutEdit = useUi((s) => s.layoutEdit);
  const showPackets = useUi((s) => s.showPackets);
  const bondUtilHost = useUi((s) => s.bondUtilHost);
  const traffic = useUi((s) => s.traffic);
  const reducedMotion = usePrefersReducedMotion();
  const history = useTraceHistory();

  const [editedLayout, setEditedLayout] = useState<LayoutMap | null>(null);
  const layoutMap = editedLayout ?? baseLayout;

  // Draw VMs under the host they currently run on (AHV HA restarts move them), and the array's
  // floating management IP inside the controller that currently holds it.
  const placed = useMemo(() => {
    const vms = relocateVms(snapshot.devices, layoutMap);
    const vips = relocateFloatingIps(vms.devices, vms.layout);
    return { ...vms, devices: vips.devices, layout: vips.layout };
  }, [snapshot.devices, layoutMap]);
  // What is drawn: a failed device's children are drawn failed too.
  const shown = useMemo(() => effectiveDevices(placed.devices), [placed.devices]);
  const restartedFrom = useMemo(() => {
    const out = new Map<string, string>();
    for (const [vm, from] of placed.movedFrom) out.set(vm, snapshot.devices[from]?.label ?? from);
    return out;
  }, [placed.movedFrom, snapshot.devices]);

  const key = structureKey(placed.devices, snapshot);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute on structure, not per tick
  const { dl, geometries } = useMemo(() => {
    const layout = computeLayout(placed.devices, snapshot.links, placed.layout);
    const ends = Object.values(snapshot.links).flatMap((l) => {
      const a = layout.anchors.get(portKey(l.a.device, l.a.port));
      const b = layout.anchors.get(portKey(l.b.device, l.b.port));
      return a && b ? [{ id: l.id, a, b }] : [];
    });
    return { dl: layout, geometries: computeLinkGeometries(ends) };
  }, [key, layoutMap]);

  const selectedId = selection?.id ?? null;
  // Activity views aggregate a rolling window so multipath round-robin doesn't flicker.
  const activityTicks = useUi((s) => s.activityTicks);
  const win = useActivityWindow(activityTicks);
  const flows = useLinkFlows(activityTicks);
  const pathUsage = useMemo(
    () =>
      selection?.type === 'device'
        ? computePathUsage(win.snapshot, selection.id, win.vmPaths.get(selection.id))
        : null,
    [win, selection],
  );

  const utilLabels = useMemo(() => {
    const out = new Map<string, string>();
    if (!bondUtilHost) return out;
    for (const bond of bondUtilization(win.snapshot, bondUtilHost)) {
      for (const m of bond.members) out.set(m.nicId, `${Math.round(m.share * 100)}%`);
    }
    return out;
  }, [win, bondUtilHost]);

  const edgeLabels = useMemo(() => {
    const out = new Map<string, string>();
    if (!bondUtilHost) return out;
    for (const bond of bondUtilization(win.snapshot, bondUtilHost)) {
      for (const m of bond.members) {
        const perTick = Math.round(m.total / win.ticks);
        if (m.linkId && m.status === 'up') out.set(m.linkId, `${bond.label} ${perTick}/tick`);
      }
    }
    return out;
  }, [win, bondUtilHost]);

  const animate = showPackets && !reducedMotion;
  const glow = useMemo(() => {
    // Always on: a steady, fading glow shows which cables carry IO; packets animate on top.
    const out = new Map<string, { color: string; dropped: boolean; opacity: number }>();
    for (const [id, a] of win.links) {
      out.set(id, {
        color: trafficStyle(a.category).color,
        dropped: a.dropped,
        opacity: glowOpacity(a.age, win.ticks),
      });
    }
    return out;
  }, [win]);

  const nodes = useMemo<DeviceNode[]>(
    () =>
      buildNodes(shown, dl, {
        selectedId,
        pathUsage,
        utilLabels,
        draggable: layoutEdit,
        restartedFrom,
      }),
    [shown, dl, selectedId, pathUsage, utilLabels, layoutEdit, restartedFrom],
  );
  const edges = useMemo<CableEdge[]>(
    () =>
      buildEdges(snapshot.links, shown, geometries, {
        selectedId,
        pathUsage,
        glow,
        labels: edgeLabels,
      }),
    [snapshot.links, shown, geometries, selectedId, pathUsage, glow, edgeLabels],
  );

  const replayCtx = useMemo<ReplayContext>(
    () => ({
      links: snapshot.links,
      geometry: geometries,
      devicePoint: (id: string): Point | undefined => {
        const r = dl.placed.get(id)?.rect;
        return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : undefined;
      },
    }),
    [snapshot.links, geometries, dl],
  );

  // Traffic filter (legend): hidden categories are neither animated nor glowing.
  const visibleTraces = useMemo(
    () => snapshot.traces.filter((t) => isCategoryVisible(traffic, t.category)),
    [snapshot.traces, traffic],
  );
  const drops = useMemo<DropContext>(
    () => ({
      previous: new Set(
        (prev?.traces ?? []).filter((t) => t.result === 'dropped').map((t) => dropKey(t)),
      ),
      isDead: deadChecker(shown, snapshot.links),
    }),
    [prev, shown, snapshot.links],
  );
  const legendCategories = useMemo(
    () => [...new Set(win.snapshot.traces.map((t) => t.category))].sort(categoryOrder),
    [win],
  );
  const anyDropped = useMemo(() => win.snapshot.traces.some((t) => t.result === 'dropped'), [win]);

  const onNodesChange = useCallback(
    (changes: NodeChange<DeviceNode>[]) => {
      for (const c of changes) {
        if (c.type === 'select' && c.selected) select({ type: 'device', id: c.id });
        if (c.type === 'position' && c.position && layoutEdit) {
          const parent = dl.placed.get(c.id)?.parent;
          const pr = parent ? dl.placed.get(parent)?.rect : undefined;
          const abs = { x: c.position.x + (pr?.x ?? 0), y: c.position.y + (pr?.y ?? 0) };
          setEditedLayout((p) => moveDevice(p ?? baseLayout, dl, snapshot.devices, c.id, abs));
        }
      }
    },
    [select, layoutEdit, dl, baseLayout, snapshot.devices],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<CableEdge>[]) => {
      for (const c of changes)
        if (c.type === 'select' && c.selected) select({ type: 'link', id: c.id });
    },
    [select],
  );

  return (
    <div className="relative h-full w-full" data-testid="diagram">
      <ReactFlow<DeviceNode, CableEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={colorMode}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, n) => select({ type: 'device', id: n.id })}
        onEdgeClick={(_, e) => select({ type: 'link', id: e.id })}
        onPaneClick={() => select(null)}
        onNodeContextMenu={(ev, n) => {
          ev.preventDefault();
          openContextMenu({ target: { type: 'device', id: n.id }, x: ev.clientX, y: ev.clientY });
        }}
        onEdgeContextMenu={(ev, e) => {
          ev.preventDefault();
          openContextMenu({ target: { type: 'link', id: e.id }, x: ev.clientX, y: ev.clientY });
        }}
        onEdgeMouseEnter={(ev, e) => setHoveredLink({ id: e.id, x: ev.clientX, y: ev.clientY })}
        onEdgeMouseMove={(ev, e) => setHoveredLink({ id: e.id, x: ev.clientX, y: ev.clientY })}
        onEdgeMouseLeave={() => setHoveredLink(null)}
        connectionMode={ConnectionMode.Loose}
        zIndexMode="manual"
        nodesConnectable={false}
        nodesDraggable={layoutEdit}
        elementsSelectable
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        deleteKeyCode={null}
        fitView
        fitViewOptions={FIT_VIEW}
        minZoom={0.2}
        maxZoom={3}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} position="bottom-right" fitViewOptions={FIT_VIEW} />
        {animate ? (
          <PacketOverlay
            flows={flows}
            geometry={geometries}
            ticks={win.ticks}
            traces={visibleTraces}
            version={snapshot.version}
            ctx={replayCtx}
            drops={drops}
          />
        ) : null}
        <Panel position="bottom-left">
          <Legend
            categories={legendCategories}
            dropped={anyDropped}
            animated={animate}
            reducedMotion={reducedMotion}
          />
        </Panel>
        {layoutEdit ? (
          <Panel position="top-right">
            <LayoutEditPanel layout={dl} onReset={() => setEditedLayout(null)} />
          </Panel>
        ) : null}
      </ReactFlow>
      <LinkHoverCard history={history} />
      <ContextMenu />
    </div>
  );
}
