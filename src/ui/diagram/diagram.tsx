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
import { buildDataPath, hopFlows, hopLinks, isIoLink, placeDataPath } from './data-path';
import { EdgeLabelLayer } from './edges/edge-label-layer';
import { effectiveDevices } from './effective-status';
import { buildEdges, buildNodes, type CableEdge, type DeviceNode } from './flow';
import type { Side } from './geometry';
import { computeLinkGeometries, type Point } from './geometry';
import {
  useActivityWindow,
  useLinkFlows,
  usePrefersReducedMotion,
  usePreviousSnapshot,
  useTraceHistory,
} from './hooks';
import { islLabel, islLinks, islShares } from './isl-share';
import { islWhy } from './isl-why';
import { cableLabelAnchors } from './label-anchor';
import { computeLayout, type LayoutMap, moveDevice, portKey } from './layout';
import { LayoutEditPanel } from './layout-edit-panel';
import { Legend } from './legend';
import { LinkHoverCard } from './link-hover-card';
import { linkUsageLabels } from './link-usage';
import { buildMeters } from './meters';
import { PacketOverlay } from './packet-overlay';
import { bondUtilization, computePathUsage } from './path-usage';
import { type DropContext, deadChecker, dropKey, type ReplayContext } from './replay';
import { categoryOrder, GUI_HIDDEN_CATEGORIES, isCategoryVisible, trafficStyle } from './traffic';
import { edgeTypes, nodeTypes } from './types';
import { relocateFloatingIps, relocateVms } from './vm-placement';

/** Layout depends only on structure (ids, parents, kinds, cable ends), not on per-tick state. */
function structureKey(
  devices: Readonly<Record<string, DeviceView>>,
  links: Snapshot['links'],
): string {
  const d = Object.values(devices)
    .map((x) => `${x.id}<${x.parent ?? ''}:${x.kind}`)
    .sort()
    .join('|');
  const l = Object.values(links)
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
  const bondUtilHost = useUi((s) => s.bondUtilHost);
  const showSpeeds = useUi((s) => s.showSpeeds);
  const traffic = useUi((s) => s.traffic);
  const reducedMotion = usePrefersReducedMotion();
  const history = useTraceHistory();

  const [editedLayout, setEditedLayout] = useState<LayoutMap | null>(null);
  const layoutMap = editedLayout ?? baseLayout;

  // Draw VMs under the host they currently run on (AHV HA restarts move them), and the array's
  // floating management IP inside the controller that currently holds it.
  // The I/O data path: Stargate and the redirector are derived boxes; internal hops become links.
  const model = useMemo(() => buildDataPath(snapshot), [snapshot]);
  const allLinks = useMemo(
    () => ({ ...snapshot.links, ...hopLinks(model) }),
    [snapshot.links, model],
  );
  const placed = useMemo(() => {
    const base = placeDataPath(model, snapshot.devices, layoutMap);
    const vms = relocateVms(base.devices, base.layout);
    const vips = relocateFloatingIps(vms.devices, vms.layout);
    return { ...vms, devices: vips.devices, layout: vips.layout };
  }, [model, snapshot.devices, layoutMap]);
  // What is drawn: a failed device's children are drawn failed too.
  const shown = useMemo(() => effectiveDevices(placed.devices), [placed.devices]);
  const movedFrom = useMemo(() => {
    const out = new Map<string, string>();
    for (const [vm, from] of placed.movedFrom) out.set(vm, snapshot.devices[from]?.label ?? from);
    return out;
  }, [placed.movedFrom, snapshot.devices]);

  const key = structureKey(placed.devices, allLinks);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute on structure, not per tick
  const { dl, geometries } = useMemo(() => {
    // A redirected VM leaves its host over the management uplink. Route that hop down the host's
    // left edge so it does not pass through the (failed) CVM box in between.
    const sideHints = new Map<string, Side>();
    for (const h of model.hops) {
      if (h.redirected && h.from.endsWith('.redirector') && h.to.endsWith('.host-mgmt')) {
        sideHints.set(portKey(h.from, `${h.id}:a`), 'left');
        sideHints.set(portKey(h.to, `${h.id}:b`), 'left');
      }
    }
    const layout = computeLayout(placed.devices, allLinks, placed.layout, sideHints);
    const ends = Object.values(allLinks).flatMap((l) => {
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
  const traceFlows = useLinkFlows(activityTicks);
  const flows = useMemo(
    () => [...traceFlows, ...hopFlows(model, (c) => isCategoryVisible(traffic, c))],
    [traceFlows, model, traffic],
  );
  const hops = useMemo(() => new Map(model.hops.map((h) => [h.id, h])), [model]);
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

  // Throughput model (T1): Gb/s per direction on every cable carrying storage, colored when busy.
  const usage = useMemo(
    () => (showSpeeds ? linkUsageLabels(snapshot) : new Map<string, never>()),
    [snapshot, showSpeeds],
  );
  const meters = useMemo(() => buildMeters(snapshot), [snapshot]);
  const labelTones = useMemo(
    () => new Map([...usage].map(([id, u]) => [id, u.tone] as const)),
    [usage],
  );
  // Hover text: each direction in full, plus on the ISL why storage IO crosses it (isl-why.ts).
  const labelTitles = useMemo(() => {
    const out = new Map([...usage].map(([id, u]) => [id, u.title] as const));
    for (const id of islLinks(snapshot)) {
      const why = islWhy(snapshot, id);
      if (why.length === 0) continue;
      const base = out.get(id);
      out.set(id, base ? `${base}\n\n${why.join('\n')}` : why.join('\n'));
    }
    return out;
  }, [usage, snapshot]);
  // Labels sit just outside the node or array that owns the port, and the ISL's below the switches.
  const labelAnchors = useMemo(
    () => cableLabelAnchors(allLinks, placed.devices, dl, geometries),
    [allLinks, placed.devices, dl, geometries],
  );
  const edgeLabels = useMemo(() => {
    const out = new Map<string, string>();
    for (const [id, u] of usage) out.set(id, u.text);
    // Without a throughput model: how much of the sampled storage IO crosses the ISL.
    if (usage.size === 0 && meters.line.size === 0) {
      for (const isl of islShares(win.snapshot)) {
        const label = islLabel(isl);
        if (label) out.set(isl.linkId, label);
      }
    }
    if (!bondUtilHost) return out;
    for (const bond of bondUtilization(win.snapshot, bondUtilHost)) {
      for (const m of bond.members) {
        // With the throughput model the cable already names its share of the bond.
        if (m.linkId && m.status === 'up' && !usage.has(m.linkId)) out.set(m.linkId, bond.label);
      }
    }
    return out;
  }, [win, bondUtilHost, usage, meters]);

  const animate = !reducedMotion;
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
        movedFrom,
        notes: model.notes,
        meters,
      }),
    [shown, dl, selectedId, pathUsage, utilLabels, layoutEdit, movedFrom, model, meters],
  );
  const edges = useMemo<CableEdge[]>(
    () =>
      buildEdges(allLinks, shown, geometries, {
        selectedId,
        pathUsage,
        glow,
        labels: edgeLabels,
        labelTones,
        labelTitles,
        labelAnchors,
        meters,
        hops,
        activeLinks: model.activeLinks,
      }),
    [
      allLinks,
      shown,
      geometries,
      selectedId,
      pathUsage,
      glow,
      edgeLabels,
      labelTones,
      labelTitles,
      labelAnchors,
      meters,
      hops,
      model,
    ],
  );

  const replayCtx = useMemo<ReplayContext>(
    () => ({
      links: allLinks,
      geometry: geometries,
      devicePoint: (id: string): Point | undefined => {
        const r = dl.placed.get(id)?.rect;
        return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : undefined;
      },
    }),
    [allLinks, geometries, dl],
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
      isDead: deadChecker(shown, allLinks),
    }),
    [prev, shown, allLinks],
  );
  const legendCategories = useMemo(
    () =>
      [...new Set(win.snapshot.traces.map((t) => t.category))]
        .filter((c) => !GUI_HIDDEN_CATEGORIES.has(c))
        .sort(categoryOrder),
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
        if (c.type === 'select' && c.selected && !isIoLink(c.id))
          select({ type: 'link', id: c.id });
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
        onEdgeClick={(_, e) => (isIoLink(e.id) ? select(null) : select({ type: 'link', id: e.id }))}
        onPaneClick={() => select(null)}
        onNodeContextMenu={(ev, n) => {
          ev.preventDefault();
          openContextMenu({ target: { type: 'device', id: n.id }, x: ev.clientX, y: ev.clientY });
        }}
        onEdgeContextMenu={(ev, e) => {
          ev.preventDefault();
          if (isIoLink(e.id)) return;
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
        <EdgeLabelLayer edges={edges} />
        <Panel position="bottom-left">
          <Legend
            categories={legendCategories}
            dropped={anyDropped}
            animated={animate}
            hasPath={model.enabled}
            speeds={showSpeeds && usage.size > 0}
          />
        </Panel>
        {layoutEdit ? (
          <Panel position="top-right">
            <LayoutEditPanel layout={dl} onReset={() => setEditedLayout(null)} />
          </Panel>
        ) : null}
      </ReactFlow>
      <LinkHoverCard history={history} hops={hops} />
      <ContextMenu />
    </div>
  );
}
