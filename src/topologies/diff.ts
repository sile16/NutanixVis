/**
 * Structural diff between two built topologies. A runtime option change (SPEC §5.5) is
 * "rebuild with the new value, diff, apply the field changes": runtime options only ever
 * produce `changed` entries, never added/removed devices or links, and never move the layout.
 */
import type { Topology } from './schema';

export interface FieldChange {
  readonly key: string;
  readonly from: unknown;
  readonly to: unknown;
}

export interface CollectionDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: Readonly<Record<string, readonly FieldChange[]>>;
}

export interface TopologyDiff {
  readonly devices: CollectionDiff;
  readonly links: CollectionDiff;
  readonly vlans: CollectionDiff;
  readonly layout: CollectionDiff;
  readonly isEmpty: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function diffCollection(
  before: ReadonlyMap<string, object>,
  after: ReadonlyMap<string, object>,
): CollectionDiff {
  const added = [...after.keys()].filter((k) => !before.has(k)).sort();
  const removed = [...before.keys()].filter((k) => !after.has(k)).sort();
  const changed: Record<string, FieldChange[]> = {};
  for (const [id, a] of before) {
    const b = after.get(id);
    if (!b) continue;
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort();
    const fields = keys
      .filter((k) => !same(ra[k], rb[k]))
      .map((k) => ({ key: k, from: ra[k], to: rb[k] }));
    if (fields.length) changed[id] = fields;
  }
  return { added, removed, changed };
}

const byId = <T extends { id: string | number }>(xs: readonly T[]) =>
  new Map<string, object>(xs.map((x) => [String(x.id), x]));

const emptyColl = (c: CollectionDiff) =>
  !c.added.length && !c.removed.length && !Object.keys(c.changed).length;

export function diffTopologies(before: Topology, after: Topology): TopologyDiff {
  const devices = diffCollection(byId(before.devices), byId(after.devices));
  const links = diffCollection(byId(before.links), byId(after.links));
  const vlans = diffCollection(byId(before.vlans), byId(after.vlans));
  const layout = diffCollection(
    new Map(Object.entries(before.layout)),
    new Map(Object.entries(after.layout)),
  );
  return {
    devices,
    links,
    vlans,
    layout,
    isEmpty: [devices, links, vlans, layout].every(emptyColl),
  };
}
