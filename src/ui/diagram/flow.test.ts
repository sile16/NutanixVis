import { describe, expect, it } from 'vitest';
import { loadSimulation } from '../../loader/simulation';
import { effectiveDevices } from './effective-status';
import { buildNodes, nodeTypeFor } from './flow';
import { computeLayout } from './layout';
import { splitDiskLabel } from './nodes/device-nodes';

describe('nodeTypeFor', () => {
  it('draws the engine view kind "bond" as a vswitch (bond mode on the card)', () => {
    expect(nodeTypeFor('bond')).toBe('vswitch');
    expect(nodeTypeFor('vswitch')).toBe('vswitch');
    expect(nodeTypeFor('something-new')).toBe('generic');
  });

  it('gives every device of every real topology a known node type', () => {
    const { sim } = loadSimulation({ topologyId: 't3-co-hci', versions: { nutanix: 'aos-7.6' } });
    const kinds = new Set(Object.values(sim.getSnapshot().devices).map((d) => d.kind));
    kinds.delete('nutanix-cluster'); // logical: shown in panels, not drawn
    for (const k of kinds) expect(nodeTypeFor(k), k).not.toBe('generic');
  });
});

describe('buildNodes', () => {
  it('declares each port handle as source and target (no React Flow error 008 on mount)', () => {
    const { sim } = loadSimulation({
      topologyId: 't1-lab',
      versions: { nutanix: 'aos-7.6', flasharray: 'purity-6.12' },
    });
    const s = sim.getSnapshot();
    const dl = computeLayout(s.devices, s.links, {});
    const nodes = buildNodes(effectiveDevices(s.devices), dl, {
      selectedId: null,
      pathUsage: null,
      utilLabels: new Map(),
      draggable: false,
    });
    const sw = nodes.find((n) => n.id === 'sw-a');
    const ids = (type: string) =>
      (sw?.handles ?? []).filter((h) => h.type === type).map((h) => h.id);
    expect(ids('source').length).toBeGreaterThan(0);
    expect(ids('target')).toEqual(ids('source'));
  });
});

describe('splitDiskLabel', () => {
  it('stacks media over number so a 28 px disk card stays readable', () => {
    expect(splitDiskLabel('NVMe 1')).toEqual(['NVMe', '1']);
    expect(splitDiskLabel('SSD 12')).toEqual(['SSD', '12']);
    expect(splitDiskLabel('disk')).toEqual(['disk', '']);
  });
});
