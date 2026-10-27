/**
 * Traffic-category legend (SPEC §5.4): packet color per category. The palette starts from
 * Okabe-Ito (color-blind safe) and is shared by the canvas overlay and the legend, so the legend is
 * always the source of truth. Unknown categories get a stable fallback color.
 */

export interface TrafficStyle {
  readonly label: string;
  readonly color: string;
}

export const TRAFFIC: Readonly<Record<string, TrafficStyle>> = {
  'io-read': { label: 'IO read', color: '#0072b2' },
  'io-write': { label: 'IO write', color: '#e69f00' },
  'nvme-io': { label: 'NVMe/TCP IO', color: '#56b4e9' },
  'nvme-keepalive': { label: 'NVMe keep-alive', color: '#009e73' },
  keepalive: { label: 'Keep-alive', color: '#009e73' },
  replication: { label: 'Replication', color: '#cc79a7' },
  'iscsi-nop': { label: 'iSCSI NOP', color: '#b59f00' },
  zk: { label: 'Zookeeper', color: '#8b5cf6' },
  cassandra: { label: 'Cassandra', color: '#0d9488' },
  'ha-poll': { label: 'HA heartbeat', color: '#64748b' },
  mgmt: { label: 'Management', color: '#94a3b8' },
};

export const DROP_COLOR = '#ef4444';

const FALLBACK = ['#d55e00', '#f472b6', '#22d3ee', '#a3e635', '#fb923c'];

export function trafficStyle(category: string): TrafficStyle {
  const known = TRAFFIC[category];
  if (known) return known;
  let h = 0;
  for (const ch of category) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { label: category, color: FALLBACK[h % FALLBACK.length] ?? '#d55e00' };
}

/** Categories that represent storage IO (used by the path-usage view). */
export function isStorageCategory(category: string): boolean {
  return category.startsWith('io-') || category.startsWith('nvme') || category === 'iscsi-nop';
}
