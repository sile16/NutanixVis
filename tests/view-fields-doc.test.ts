/**
 * Every view field the T1 configurations emit is documented in docs/view-fields.md (the UI's
 * contract). HCI and T3 topologies are not checked yet (docs/STATUS.md lists their fields to document).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSimulation } from '../src/loader/simulation';

const DOC = readFileSync(resolve(__dirname, '../docs/view-fields.md'), 'utf8');

/** Keys named in a table's first column (several per cell allowed) and in prose code spans. */
function documented(): Set<string> {
  const out = new Set<string>();
  for (const line of DOC.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const first = line.split('|')[1] ?? '';
    for (const m of first.matchAll(/`([^`]+)`/g)) out.add(m[1] as string);
  }
  // The throughput-model section documents `links` and `saturated` in prose.
  for (const m of DOC.matchAll(/`(links|saturated)`/g)) out.add(m[1] as string);
  return out;
}

const pattern = (k: string): string => k.replace(/^(member|buckets)\..+$/, '$1.<nic>');

const T1_CONFIGS = [
  { 'node-count': 3, 'vm-layout': 'two-plus-spare', 'vm-load-gbps': 'line-rate' },
  { 'storage-vswitch-layout': 'per-fabric' },
  { 'vs1-bond-mode': 'balance-tcp', mlag: true },
  { 'vs1-bond-mode': 'active-backup' },
] as const;

describe('view-field contract doc', () => {
  it('documents every field the T1 configurations emit', () => {
    const doc = documented();
    const missing = new Set<string>();
    for (const options of T1_CONFIGS) {
      const sim = loadSimulation({ topologyId: 't1-ahv-flasharray', options, seed: 1 }).sim;
      const s = sim.tick(5);
      for (const d of Object.values(s.devices)) {
        for (const k of Object.keys(d.fields)) {
          if (!doc.has(pattern(k))) missing.add(`${d.kind}.${k}`);
        }
      }
      for (const [k, v] of Object.entries(s.derived)) {
        const keys = v !== null && typeof v === 'object' ? Object.keys(v) : [k];
        for (const key of keys) if (!doc.has(key)) missing.add(`derived.${key}`);
      }
    }
    expect([...missing].sort(), 'add these to docs/view-fields.md').toEqual([]);
  });
});
