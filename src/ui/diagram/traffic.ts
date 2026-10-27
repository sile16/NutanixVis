/**
 * Traffic-category legend (SPEC §5.4): packet color per category. The palette starts from
 * Okabe-Ito (color-blind safe) and is shared by the canvas overlay and the legend, so the legend is
 * always the source of truth. Unknown categories get a stable fallback color.
 *
 * Also the traffic filter (pure): which categories the overlay, cable glow and hover card show.
 */

export interface TrafficStyle {
  readonly label: string;
  readonly color: string;
  /** What this traffic is (legend tooltip). */
  readonly description?: string;
}

export const TRAFFIC: Readonly<Record<string, TrafficStyle>> = {
  'io-read': {
    label: 'IO read',
    color: '#0072b2',
    description:
      'VM read IO to Stargate: over iSCSI through the AHV redirector, or a remote replica read (HCI).',
  },
  'io-write': {
    label: 'IO write',
    color: '#e69f00',
    description: 'VM write IO to Stargate over iSCSI through the AHV iSCSI redirector.',
  },
  'nvme-io': {
    label: 'NVMe/TCP IO',
    color: '#56b4e9',
    description: 'NVMe/TCP IO between a CVM (Stargate) and the FlashArray controller ports.',
  },
  'nvme-keepalive': {
    label: 'NVMe keep-alive',
    color: '#009e73',
    description:
      'NVMe/TCP admin queue: connect, keep-alive and reservations. A missed keep-alive marks the path lost.',
  },
  keepalive: { label: 'Keep-alive', color: '#009e73', description: 'Keep-alive heartbeat.' },
  replication: {
    label: 'Replication',
    color: '#cc79a7',
    description:
      'Oplog write replicated to a remote CVM (RF2/RF3) before the write is acknowledged.',
  },
  rebuild: {
    label: 'Rebuild',
    color: '#d55e00',
    description: 'Curator re-replication of extent groups after a disk or node is lost.',
  },
  'iscsi-nop': {
    label: 'iSCSI NOP',
    color: '#b59f00',
    description:
      'iSCSI NOP: AHV redirector health check of Stargate (Autopath). VM disks reach Stargate over iSCSI via the host redirector; missed NOPs make it redirect to another Stargate.',
  },
  zk: {
    label: 'Zookeeper',
    color: '#8b5cf6',
    description: 'Zookeeper ensemble and session traffic between CVMs (configuration, leadership).',
  },
  cassandra: {
    label: 'Cassandra',
    color: '#0d9488',
    description: 'Cassandra metadata ring traffic between CVMs.',
  },
  'ha-poll': {
    label: 'HA heartbeat',
    color: '#64748b',
    description:
      'AHV HA: Acropolis leader to host libvirtd heartbeat. Missed heartbeats disconnect the host and trigger VM restarts.',
  },
  mgmt: {
    label: 'Management',
    color: '#94a3b8',
    description: 'Management traffic, e.g. the cluster calling the FlashArray management API.',
  },
};

export const DROP_COLOR = '#ef4444';

const FALLBACK = ['#f472b6', '#22d3ee', '#a3e635', '#fb923c', '#d55e00'];

export function trafficStyle(category: string): TrafficStyle {
  const known = TRAFFIC[category];
  if (known) return known;
  let h = 0;
  for (const ch of category) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { label: category, color: FALLBACK[h % FALLBACK.length] ?? '#d55e00' };
}

/** Legend order: known categories first (in `TRAFFIC` order), then the rest alphabetically. */
export function categoryOrder(a: string, b: string): number {
  const keys = Object.keys(TRAFFIC);
  const ia = keys.indexOf(a);
  const ib = keys.indexOf(b);
  if (ia !== ib) return (ia < 0 ? keys.length : ia) - (ib < 0 ? keys.length : ib);
  return a.localeCompare(b);
}

/** Categories that represent storage IO (used by the path-usage view). */
export function isStorageCategory(category: string): boolean {
  return category.startsWith('io-') || category.startsWith('nvme') || category === 'iscsi-nop';
}

/** Data-carrying storage IO, for the "Storage IO only" filter preset (no health checks). */
export const STORAGE_IO_CATEGORIES: ReadonlySet<string> = new Set([
  'io-read',
  'io-write',
  'nvme-io',
  'replication',
  'rebuild',
]);

export type TrafficPreset = 'all' | 'storage' | 'none';

/**
 * Which categories are shown: a preset decides the default, and per-category toggles override it.
 * Categories never seen before follow the preset, so "None" also hides new kinds of traffic.
 */
export interface TrafficFilter {
  readonly preset: TrafficPreset;
  readonly overrides: Readonly<Record<string, boolean>>;
}

export const SHOW_ALL: TrafficFilter = { preset: 'all', overrides: {} };

export function isCategoryVisible(f: TrafficFilter, category: string): boolean {
  const o = f.overrides[category];
  if (o !== undefined) return o;
  if (f.preset === 'all') return true;
  if (f.preset === 'none') return false;
  return STORAGE_IO_CATEGORIES.has(category);
}

export function toggleCategory(f: TrafficFilter, category: string): TrafficFilter {
  return { ...f, overrides: { ...f.overrides, [category]: !isCategoryVisible(f, category) } };
}

export const presetFilter = (preset: TrafficPreset): TrafficFilter => ({ preset, overrides: {} });

export const isShowAll = (f: TrafficFilter): boolean =>
  f.preset === 'all' && Object.values(f.overrides).every(Boolean);

/** Parse a stored filter, falling back to "show all" on anything unexpected. */
export function parseTrafficFilter(raw: string | null): TrafficFilter {
  if (!raw) return SHOW_ALL;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return SHOW_ALL;
    const { preset, overrides } = v as { preset?: unknown; overrides?: unknown };
    if (preset !== 'all' && preset !== 'storage' && preset !== 'none') return SHOW_ALL;
    const o: Record<string, boolean> = {};
    if (typeof overrides === 'object' && overrides !== null) {
      for (const [k, b] of Object.entries(overrides)) if (typeof b === 'boolean') o[k] = b;
    }
    return { preset, overrides: o };
  } catch {
    return SHOW_ALL;
  }
}
