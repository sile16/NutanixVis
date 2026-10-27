import { describe, expect, it } from 'vitest';
import {
  blockAwareness,
  HciStore,
  placeReplicas,
  readLayout,
} from '../../../src/domain/nutanix/hci';
import { current } from '../../../src/domain/versions/profiles/current';
import { buildTopology } from '../../../src/topologies';

const E = current.hci.extentGroupsPerVdisk.value;

function storeFor(id: Parameters<typeof buildTopology>[0], options = {}) {
  const t = buildTopology(id, options);
  const layout = readLayout(t);
  return { layout, store: new HciStore(layout, current), topology: t };
}

describe('block-awareness rule (Bible 4i)', () => {
  it('needs ≥3 blocks and the others to hold ≥2X nodes under FT1', () => {
    expect(blockAwareness(['b1', 'b2', 'b3'], 1)).toBe('met');
    expect(blockAwareness(['b1', 'b2', 'b3', 'b1', 'b2', 'b3'], 1)).toBe('met');
    // 2 + 1 + 1: X = 2, the rest hold 2 < 4.
    expect(blockAwareness(['b1', 'b2', 'b3', 'b1'], 1)).toBe('not-met');
    expect(blockAwareness(['b1', 'b1', 'b1', 'b1'], 1)).toBe('not-met');
    expect(blockAwareness(['b1', 'b2'], 1)).toBe('not-met');
  });

  it('needs ≥5 blocks and 4X under FT2', () => {
    expect(blockAwareness(['b1', 'b2', 'b3', 'b4', 'b5'], 2)).toBe('met');
    expect(blockAwareness(['b1', 'b2', 'b3', 'b4'], 2)).toBe('not-met');
    expect(blockAwareness(['b1', 'b2', 'b3', 'b1', 'b2', 'b3'], 2)).toBe('not-met');
  });

  it('is off when nodes carry no block assignment', () => {
    expect(blockAwareness(['b1', undefined, 'b3'], 1)).toBe('off');
    expect(blockAwareness([], 1)).toBe('off');
  });
});

describe('placeReplicas', () => {
  const nodes = ['n1', 'n2', 'n3', 'n4'];
  const blocks: Record<string, string> = { n1: 'b1', n2: 'b2', n3: 'b3', n4: 'b1' };
  const base = {
    candidates: nodes,
    exclude: new Set<string>(),
    blockOf: (n: string) => blocks[n],
  };

  it('puts the first replica on the writing node and the rest on distinct nodes', () => {
    for (let key = 0; key < 12; key++) {
      const r2 = placeReplicas({ ...base, key, first: 'n1', count: 2, blockAware: false });
      expect(r2[0]).toBe('n1');
      expect(new Set(r2).size).toBe(2);
      const r3 = placeReplicas({ ...base, key, first: 'n2', count: 3, blockAware: false });
      expect(r3[0]).toBe('n2');
      expect(new Set(r3).size).toBe(3);
    }
  });

  it('is deterministic', () => {
    const a = placeReplicas({ ...base, key: 5, first: 'n3', count: 2, blockAware: true });
    const b = placeReplicas({ ...base, key: 5, first: 'n3', count: 2, blockAware: true });
    expect(a).toEqual(b);
  });

  it('with block awareness, never pairs n1 with n4 (same block) while another block is free', () => {
    for (let key = 0; key < 12; key++) {
      const r = placeReplicas({ ...base, key, first: 'n1', count: 2, blockAware: true });
      expect(r).not.toContain('n4');
    }
  });

  it('without block awareness, some placements share a block', () => {
    const pairs = Array.from({ length: 12 }, (_, key) =>
      placeReplicas({ ...base, key, first: 'n1', count: 2, blockAware: false }),
    );
    expect(pairs.some((p) => p.includes('n4'))).toBe(true);
  });

  it('falls back to node-only placement when no unused block remains', () => {
    const r = placeReplicas({
      ...base,
      key: 0,
      count: 1,
      candidates: ['n4'],
      usedBlocks: new Set(['b1']),
      blockAware: true,
    });
    expect(r).toEqual(['n4']);
  });

  it('returns fewer nodes when there are not enough candidates', () => {
    expect(
      placeReplicas({ ...base, key: 0, count: 3, candidates: ['n1', 'n2'], blockAware: false }),
    ).toHaveLength(2);
  });
});

describe('initial extent-group placement', () => {
  it.each([
    [2, 4],
    [3, 5],
  ])('RF%i on %i nodes: RF distinct nodes, first replica local', (rf, n) => {
    const { layout, store } = storeFor('t2-hci-ahv', { 'replication-factor': rf, 'node-count': n });
    expect(store.rf).toBe(rf);
    expect(store.extentGroups()).toHaveLength(layout.vdisks.length * E);
    for (const eg of store.extentGroups()) {
      expect(eg.replicas).toHaveLength(rf);
      expect(new Set(eg.replicas.map((r) => r.node)).size).toBe(rf);
      expect(eg.replicas[0]?.node).toBe(eg.home);
      for (const r of eg.replicas)
        expect(r.disk.startsWith(r.node.replace('.cvm', '.'))).toBe(true);
    }
  });

  it('spreads replicas evenly over nodes and disks', () => {
    const { store, layout } = storeFor('t2-hci-ahv');
    const perNode = layout.nodes.map((n) => store.replicasOn(n.cvm));
    expect(Math.max(...perNode) - Math.min(...perNode)).toBeLessThanOrEqual(2);
    for (const d of layout.disks) expect(store.replicasOnDisk(d.id)).toBeGreaterThan(0);
  });

  it('block awareness met (6 nodes, 3 blocks): no two replicas share a block', () => {
    const { store } = storeFor('t2-hci-ahv', { 'node-count': 6, 'block-layout': 'three-blocks' });
    expect(store.blockAwareness).toBe('met');
    for (const eg of store.extentGroups()) {
      const blocks = eg.replicas.map((r) => store.blockOf(r.node));
      expect(new Set(blocks).size).toBe(blocks.length);
    }
  });

  it('block awareness not met (4 nodes, 3 blocks): some replicas share block 1', () => {
    const { store } = storeFor('t2-hci-ahv', { 'node-count': 4, 'block-layout': 'three-blocks' });
    expect(store.blockAwareness).toBe('not-met');
    const shared = store
      .extentGroups()
      .filter(
        (eg) => new Set(eg.replicas.map((r) => store.blockOf(r.node))).size < eg.replicas.length,
      );
    expect(shared.length).toBeGreaterThan(0);
  });

  it('T3: only CVM-bearing nodes hold data; CO vDisks are spread round-robin', () => {
    const { store, layout, topology } = storeFor('t3-co-so');
    const co = topology.devices.filter((d) => d.kind === 'ahv-host' && d.role === 'compute-only');
    expect(layout.nodes.map((n) => n.host)).not.toEqual(expect.arrayContaining([co[0]?.id]));
    const holders = new Set(store.extentGroups().flatMap((eg) => eg.replicas.map((r) => r.node)));
    expect([...holders].sort()).toEqual(layout.nodes.map((n) => n.cvm));
    const homes = new Set(layout.vdisks.map((v) => v.home));
    expect(homes.size).toBe(layout.nodes.length);
    expect(store.blockAwareness).toBe('off');
  });
});
