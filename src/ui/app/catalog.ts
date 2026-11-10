/**
 * Real topology catalog (stream I integration). Each entry builds a live engine simulation through
 * the loader. Fixture demos stay available for traffic animation until the Phase 2 domain models
 * emit real traffic.
 */

import { type CatalogEntry, fixtureCatalog } from '../../fixtures/catalog';
import { loadSimulation } from '../../loader/simulation';
import { buildTopology, type TopologyId, topologies, topologyIds } from '../../topologies';
import type { Choice } from '../../topologies/options';
import type { Topology } from '../../topologies/schema';
import { T1_CONFIGS } from '../../topologies/t1-configs';

const TITLES: Readonly<Record<Exclude<TopologyId, 't1-ahv-flasharray'>, string>> = {
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

function t1Variant(
  id: string,
  title: string,
  options: Readonly<Record<string, Choice>>,
): CatalogEntry {
  return {
    id,
    title,
    hasFlashArray: true,
    layout: absoluteLeafLayout(buildTopology('t1-ahv-flasharray', options)),
    createSimulation: (versions) =>
      loadSimulation({
        topologyId: 't1-ahv-flasharray',
        options,
        versions: {
          nutanix: versions.nutanix,
          ...(versions.flasharray ? { flasharray: versions.flasharray } : {}),
        },
      }).sim,
  };
}

/** The five storage-network configurations being compared (`src/topologies/t1-configs.ts`). */
const t1Entries: CatalogEntry[] = T1_CONFIGS.map((c) => t1Variant(c.catalogId, c.title, c.options));

/** The other topologies at their defaults (T1-lab, HCI, T3): buildable, not offered. */
const realEntries: CatalogEntry[] = topologyIds
  .filter((id): id is Exclude<TopologyId, 't1-ahv-flasharray'> => id !== 't1-ahv-flasharray')
  .map((id) => ({
    id,
    title: TITLES[id],
    hasFlashArray: topologies[id].devices.some((d) => d.kind === 'fa-array'),
    layout: absoluteLeafLayout(topologies[id]),
    createSimulation: (versions) =>
      loadSimulation({
        topologyId: id,
        versions: {
          nutanix: versions.nutanix,
          ...(versions.flasharray ? { flasharray: versions.flasharray } : {}),
        },
      }).sim,
  }));

/** Fixture demos (scripted traffic); not offered in the UI. */
export const demoEntries: CatalogEntry[] = fixtureCatalog.map((e) => ({
  ...e,
  id: `demo-${e.id}`,
  title: `${e.title} (demo traffic)`,
}));

/** Every topology the loader can build, for tests and tooling. */
export const fullCatalog: readonly CatalogEntry[] = [...t1Entries, ...realEntries, ...demoEntries];

/**
 * What the UI offers: the five storage-network configurations being compared. Other topologies
 * (T1-lab, HCI, T3) and the demo entries stay buildable through `fullCatalog`.
 */
export const catalog: readonly CatalogEntry[] = t1Entries;
