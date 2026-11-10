import type { ViewField } from '../../engine/types';

/** Words that stay acronyms, keep their product casing, or are units, in a humanized key. */
const WORDS: Readonly<Record<string, string>> = {
  ahv: 'AHV',
  ana: 'ANA',
  cvm: 'CVM',
  cvms: 'CVMs',
  dnd: 'DND',
  fa: 'FA',
  ft: 'FT',
  gbps: 'Gb/s',
  ha: 'HA',
  io: 'IO',
  iops: 'IOPS',
  ip: 'IP',
  ips: 'IPs',
  isl: 'ISL',
  kato: 'KATO',
  lacp: 'LACP',
  mgmt: 'mgmt',
  mlag: 'MLAG',
  mtu: 'MTU',
  nic: 'NIC',
  nics: 'NICs',
  nvme: 'NVMe',
  ovs: 'OVS',
  pct: '%',
  rf: 'RF',
  us: 'µs',
  vdisk: 'vDisk',
  vdisks: 'vDisks',
  vlan: 'VLAN',
  vlans: 'VLANs',
  vm: 'VM',
  vms: 'VMs',
  zk: 'ZK',
};

/** Humanise a camelCase / kebab-case field key for the inspector. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/^engine\./, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((w) => WORDS[w.toLowerCase()] ?? w.toLowerCase());
  const first = words[0] ?? '';
  if (first && !(first.toLowerCase() in WORDS)) words[0] = first[0]?.toUpperCase() + first.slice(1);
  return words.join(' ');
}

/** `ZOOKEEPER` / `FREE_SPACE` → `Zookeeper` / `Free space`; other keys are kept as they are. */
const recordKey = (k: string): string =>
  /^[A-Z][A-Z0-9_]+$/.test(k) ? humanizeKey(k.toLowerCase()) : k;

/** Whole numbers as they are; fractions to at most two decimals (2.097152 → 2.1). */
export const formatNumber = (v: number): string =>
  Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);

const scalar = (v: unknown): string => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/**
 * A view field as text. JSON-encoded lists and records (docs/view-fields.md "JSON string[]",
 * "JSON Record") read as `a, b` and `key value, key value`, and an empty one as `none`, rather
 * than as raw JSON.
 */
export function formatField(v: ViewField): string {
  if (typeof v === 'string' && /^[[{]/.test(v)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      return v;
    }
    if (Array.isArray(parsed)) return parsed.length === 0 ? 'none' : parsed.map(scalar).join(', ');
    if (parsed !== null && typeof parsed === 'object') {
      const entries = Object.entries(parsed);
      if (entries.length === 0) return 'none';
      return entries.map(([k, x]) => `${recordKey(k)} ${scalar(x)}`).join(', ');
    }
  }
  return scalar(v);
}
