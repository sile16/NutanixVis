/**
 * The topology diagram: React Flow renders device nodes and cables laid out by `layout.ts` and
 * routed by `geometry.ts`; the canvas `PacketOverlay` replays traces on top. The diagram only
 * reads snapshots; user intent goes through the UI store and `useSimControls`.
 */
import {
  Background,
  type ColorMode,
  ConnectionMode,
  Controls,
  type EdgeChange,
  type NodeChange,
  Panel,
  ReactFlow,
} from '@xyflow/react';
import { useCallback, useMemo, useState } from 'react';
import type { Snapshot } from '../../engine/types';
import { PAUSED_REPLAY_MS, playbackSchedule } from '../store/playback';
import { useSnapshot } from '../store/sim-context';
import { useUi } from '../store/ui-store';
import { ContextMenu } from './context-menu';
import { buildEdges, buildNodes, type CableEdge, type DeviceNode } from './flow';
import { computeLinkGeometries, type Point } from './geometry';
import { usePrefersReducedMotion, useTraceHistory } from './hooks';
import { computeLayout, type LayoutMap, moveDevice, portKey } from './layout';
import { LayoutEditPanel } from './layout-edit-panel';
import { Legend } from './legend';
import { LinkHoverCard } from './link-hover-card';
import { PacketOverlay } from './packet-overlay';
import { bondUtilization, computePathUsage } from './path-usage';
import type { ReplayContext } from './replay';
import { trafficStyle } from './traffic';
import { edgeTypes, nodeTypes } from './types';

/** Layout depends only on structure (ids, parents, kinds, cable ends), not on per-tick state. */
function structureKey(s: Snapshot): string {
  const d = Object.values(s.devices)
    .map((x) => `${x.id}<${x.parent ?? ''}:${x.kind}`)
    .sort()
    .join('|');
  const l = Object.values(s.links)
    .map((x) => `${x.id}=${x.a.device}#${x.a.port}~${x.b.device}#${x.b.port}`)
    .sort()
    .join('|');
  return `${d}//${l}`;
}

export function Diagram({
  baseLayout,
  colorMode,
}: {
  baseLayout: LayoutMap;
  colorMode: ColorMode;
}) {
  const snapshot = useSnapshot();
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const openContextMenu = useUi((s) => s.openContextMenu);
  const setHoveredLink = useUi((s) => s.setHoveredLink);
  const layoutEdit = useUi((s) => s.layoutEdit);
  const showPackets = useUi((s) => s.showPackets);
  const bondUtilHost = useUi((s) => s.bondUtilHost);
  const playing = useUi((s) => s.playing);
  const speed = useUi((s) => s.speed);
  const reducedMotion = usePrefersReducedMotion();
  const history = useTraceHistory(snapshot);

  const [editedLayout, setEditedLayout] = useState<LayoutMap | null>(null);
  const layoutMap = editedLayout ?? baseLayout;

  const key = structureKey(snapshot);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute on structure, not per tick
  const { dl, geometries } = useMemo(() => {
    const layout = computeLayout(snapshot.devices, snapshot.links, layoutMap);
    const ends = Object.values(snapshot.links).flatMap((l) => {
      const a = layout.anchors.get(portKey(l.a.device, l.a.port));
      const b = layout.anchors.get(portKey(l.b.device, l.b.port));
      return a && b ? [{ id: l.id, a, b }] : [];
    });
    return { dl: layout, geometries: computeLinkGeometries(ends) };
  }, [key, layoutMap]);

  const selectedId = selection?.id ?? null;
  const pathUsage = useMemo(
    () => (selection?.type === 'device' ? computePathUsage(snapshot, selection.id) : null),
    [snapshot, selection],
  );

  const utilLabels = useMemo(() => {
    const out = new Map<string, string>();
    if (!bondUtilHost) return out;
    for (const bond of bondUtilization(snapshot, bondUtilHost)) {
      for (const m of bond.members) out.set(m.nicId, `${Math.round(m.share * 100)}%`);
    }
    return out;
  }, [snapshot, bondUtilHost]);

  const edgeLabels = useMemo(() => {
    const out = new Map<string, string>();
    if (!bondUtilHost) return out;
    for (const bond of bondUtilization(snapshot, bondUtilHost)) {
      for (const m of bond.members) {
        if (m.linkId && m.status === 'up') out.set(m.linkId, `${bond.label} ${m.total}/tick`);
      }
    }
    return out;
  }, [snapshot, bondUtilHost]);

  const animate = showPackets && !reducedMotion;
  const glow = useMemo(() => {
    const out = new Map<string, { color: string; dropped: boolean }>();
    if (animate) return out;
    for (const t of snapshot.traces) {
      t.links.forEach((id, i) => {
        const dropped = t.result === 'dropped' && i === t.links.length - 1;
        const prev = out.get(id);
        if (!prev || dropped) out.set(id, { color: trafficStyle(t.category).color, dropped });
      });
    }
    return out;
  }, [snapshot.traces, animate]);

  const nodes = useMemo<DeviceNode[]>(
    () => buildNodes(snapshot, dl, { selectedId, pathUsage, utilLabels, draggable: layoutEdit }),
    [snapshot, dl, selectedId, pathUsage, utilLabels, layoutEdit],
  );
  const edges = useMemo<CableEdge[]>(
    () => buildEdges(snapshot, geometries, { selectedId, pathUsage, glow, labels: edgeLabels }),
    [snapshot, geometries, selectedId, pathUsage, glow, edgeLabels],
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

  const onNodesChange = useCallback(
    (changes: NodeChange<DeviceNode>[]) => {
      for (const c of changes) {
        if (c.type === 'select' && c.selected) select({ type: 'device', id: c.id });
        if (c.type === 'position' && c.position && layoutEdit) {
          const parent = dl.placed.get(c.id)?.parent;
          const pr = parent ? dl.placed.get(parent)?.rect : undefined;
          const abs = { x: c.position.x + (pr?.x ?? 0), y: c.position.y + (pr?.y ?? 0) };
          setEditedLayout((prev) =>
            moveDevice(prev ?? baseLayout, dl, snapshot.devices, c.id, abs),
          );
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

  const replayWindow = playing ? playbackSchedule(speed).intervalMs : PAUSED_REPLAY_MS;

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
        fitViewOptions={{ padding: 0.06 }}
        minZoom={0.2}
        maxZoom={3}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} position="bottom-right" />
        {animate ? (
          <PacketOverlay
            traces={snapshot.traces}
            version={snapshot.version}
            ctx={replayCtx}
            windowMs={replayWindow}
            loop={!playing}
          />
        ) : null}
        <Panel position="bottom-left">
          <Legend traces={snapshot.traces} animated={animate} reducedMotion={reducedMotion} />
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
