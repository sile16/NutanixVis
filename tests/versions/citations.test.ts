import { describe, expect, it } from 'vitest';
import { citations } from '../../src/domain/citations';
import { cite, matrix, profiles } from '../../src/domain/versions';
import { leaves } from './helpers';

/** Hosts we accept as public sources (SPEC §2). */
const PUBLIC_HOSTS = new Set([
  'www.nutanixbible.com',
  'portal.nutanix.com',
  'www.nutanix.com',
  'next.nutanix.com',
  'support.everpuredata.com',
  'www.everpuredata.com',
  'www.openvswitch.org',
  'docs.openvswitch.org',
  // Open vSwitch source (lib/lacp.c) on its public GitHub mirror.
  'github.com',
  'spdk.io',
  'nvmexpress.org',
  'web.archive.org',
  'linux.die.net',
  // Nutanix-employee technical blog (community-grade source, labeled unverified/assumption).
  'www.joshodgers.com',
]);

const INTERNAL = [
  /slack\.com/i,
  /atlassian\.net/i,
  /jira\./i,
  /confluence\./i,
  /docs\.google\.com/i,
  /drive\.google\.com/i,
  /purestorage\.com/i,
  /\.internal\b/i,
  /\.corp\b/i,
  /localhost/i,
  /^file:/i,
];

describe('citation registry', () => {
  const all = Object.entries(citations);

  it('ids are stable kebab-case and match their key', () => {
    for (const [key, c] of all) {
      expect(c.id).toBe(key);
      expect(key).toMatch(/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/);
    }
  });

  it.each(all)('%s points at a public https host', (_id, c) => {
    const url = new URL(c.url);
    expect(url.protocol).toBe('https:');
    expect(PUBLIC_HOSTS.has(url.hostname), url.hostname).toBe(true);
    for (const re of INTERNAL) expect(c.url).not.toMatch(re);
    expect(c.title.trim()).not.toBe('');
    expect(c.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('community posts are only on known community hosts', () => {
    const community = new Set(['next.nutanix.com', 'www.joshodgers.com']);
    for (const [, c] of all) {
      if (c.publisher === 'Community') expect(community.has(new URL(c.url).hostname)).toBe(true);
    }
  });

  it('cite() returns entries and throws on unknown ids', () => {
    expect(cite('ntnx-bible-5b').publisher).toBe('Nutanix');
    expect(() => cite('no-such-source')).toThrow(/Unknown citation/);
  });

  it('every cite id used by profiles and the matrix exists', () => {
    const used = new Set<string>();
    for (const p of Object.values(profiles))
      for (const l of leaves(p)) for (const id of l.cited.cite) used.add(id);
    for (const r of matrix) for (const id of r.cite) used.add(id);
    for (const id of used) expect(citations[id], id).toBeDefined();
  });

  it('community sources back only unverified or assumption values', () => {
    for (const p of Object.values(profiles)) {
      for (const l of leaves(p)) {
        const onlyCommunity = l.cited.cite.every((id) => citations[id]?.publisher === 'Community');
        if (l.cited.cite.length > 0 && onlyCommunity)
          expect(['unverified', 'assumption']).toContain(l.cited.confidence);
      }
    }
  });
});
