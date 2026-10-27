import { describe, expect, it } from 'vitest';
import { defineTopology, TopologySchema } from '../src/topologies/schema';

const minimal = {
  id: 'mini',
  title: 'Minimal',
  family: 't1' as const,
  description: 'Two devices and a cable.',
  vlans: [{ id: 10, name: 'storage-a', purpose: 'storage' as const }],
  devices: [
    { id: 'sw-a', label: 'Switch A', kind: 'switch' as const, vlans: [10] },
    {
      id: 'node-1',
      label: 'Node 1',
      kind: 'ahv-host' as const,
      role: 'external-storage-compute' as const,
    },
    { id: 'node-1.eth1', label: 'eth1', kind: 'nic' as const, parent: 'node-1', speedGbps: 25 },
  ],
  links: [{ id: 'l1', a: 'node-1.eth1', b: 'sw-a' }],
};

describe('topology schema', () => {
  it('accepts a minimal topology and fills defaults', () => {
    const t = defineTopology(minimal);
    expect(t.links[0]?.kind).toBe('cable');
    expect(t.options).toEqual([]);
  });

  it('rejects unknown link ends and parents', () => {
    const bad = { ...minimal, links: [{ id: 'l1', a: 'node-1.eth9', b: 'sw-a' }] };
    expect(TopologySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects duplicate device ids', () => {
    const dup = { ...minimal, devices: [...minimal.devices, minimal.devices[0]] };
    expect(TopologySchema.safeParse(dup).success).toBe(false);
  });
});
