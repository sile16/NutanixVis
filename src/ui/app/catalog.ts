/**
 * Real topology catalog (stream I integration). Each entry builds a live engine simulation through
 * the loader. Fixture demos stay available for traffic animation until the Phase 2 domain models
 * emit real traffic.
 */

import { type CatalogEntry, fixtureCatalog } from '../../fixtures/catalog';
import { loadSimulation } from '../../loader/simulation';
import type { ScenarioDef } from '../../scenarios/define';
import { buildTopology, type TopologyId, topologies, topologyIds } from '../../topologies';
import type { Topology } from '../../topologies/schema';

const TITLES: Readonly<Record<TopologyId, string>> = {
  't1-ahv-flasharray': 'T1 · AHV + Everpure FlashArray',
  't1-lab': 'T1-lab · single-NIC test drive mirror',
  't2-hci-ahv': 'T2 · Nutanix HCI on AHV',
  't3-co-so': 'T3 · Compute-only + storage-only nodes',
  't3-co-hci': 'T3 · Compute-only + HCI nodes',
};

/**
 * Topology layouts use the React Flow convention (top-level absolute, children relative to their
 * parent, groups sized). The diagram wants absolute positions for leaf devices only and computes
 * group bounds itself, so resolve parent offsets and drop groups.
 */
export function absoluteLeafLayout(t: Topology): Topology['layout'] {
  const parentOf = new Map(t.devices.map((d) => [d.id, d.parent]));
  const hasChildren = new Set(t.devices.flatMap((d) => (d.parent ? [d.parent] : [])));
  const origin = (id: string | undefined): { x: number; y: number } => {
    if (!id) return { x: 0, y: 0 };
    const own = t.layout[id] ?? { x: 0, y: 0 };
    const up = origin(parentOf.get(id));
    return { x: up.x + own.x, y: up.y + own.y };
  };
  const out: Record<string, Topology['layout'][string]> = {};
  for (const [id, box] of Object.entries(t.layout)) {
    if (hasChildren.has(id)) continue;
    const up = origin(parentOf.get(id));
    out[id] = { ...box, x: up.x + box.x, y: up.y + box.y };
  }
  return out;
}

const realEntries: CatalogEntry[] = topologyIds.map((id) => {
  const t = topologies[id];
  return {
    id,
    title: TITLES[id],
    hasFlashArray: t.devices.some((d) => d.kind === 'fa-array'),
    layout: absoluteLeafLayout(t),
    createSimulation: (versions) =>
      loadSimulation({
        topologyId: id,
        versions: {
          nutanix: versions.nutanix,
          ...(versions.flasharray ? { flasharray: versions.flasharray } : {}),
        },
      }).sim,
  };
});

/**
 * T1 variant: ONE storage network and one virtual switch with both NICs bonded (MAC pinning), so
 * the bond, its two members and the active member are visible. Only the first data port of each
 * array controller is cabled, so each CVM has two live paths and the other two portals are not
 * connected (by design). Same topology and models as T1,
 * built from its options (declarative data, no engine change).
 */
const BONDED_OPTIONS = {
  'storage-vlans': 'single',
  'vlan-placement': 'tagged-both',
  'isl-storage-vlans': 'allowed',
  'array-data-ports': 'first-only',
} as const;
const bondedEntry: CatalogEntry = {
  id: 't1-bonded-single',
  title: 'T1 · single storage network, bonded NICs',
  hasFlashArray: true,
  layout: absoluteLeafLayout(buildTopology('t1-ahv-flasharray', BONDED_OPTIONS)),
  createSimulation: (versions) =>
    loadSimulation({
      topologyId: 't1-ahv-flasharray',
      options: BONDED_OPTIONS,
      versions: {
        nutanix: versions.nutanix,
        ...(versions.flasharray ? { flasharray: versions.flasharray } : {}),
      },
    }).sim,
};

/** Fixture demos (scripted traffic) keep distinct ids and say so in their titles. */
const demoEntries: CatalogEntry[] = fixtureCatalog.map((e) => ({
  ...e,
  id: `demo-${e.id}`,
  title: `${e.title} (demo traffic)`,
}));

export const catalog: readonly CatalogEntry[] = [...realEntries, bondedEntry, ...demoEntries];

/** A guided scenario as a catalog entry: its topology built with the scenario's own options. */
export function scenarioEntry(def: ScenarioDef): CatalogEntry {
  const id = def.topology as TopologyId;
  const options = def.options ?? {};
  return {
    id: def.topology,
    title: def.title,
    hasFlashArray: topologies[id]?.devices.some((d) => d.kind === 'fa-array') ?? false,
    layout: absoluteLeafLayout(buildTopology(id, options)),
    createSimulation: (versions) =>
      loadSimulation({
        topologyId: id,
        options,
        ...(def.seed !== undefined ? { seed: def.seed } : {}),
        versions: {
          nutanix: versions.nutanix,
          ...(versions.flasharray ? { flasharray: versions.flasharray } : {}),
        },
      }).sim,
  };
}
