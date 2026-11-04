import { describe, expect, it } from 'vitest';
import { loadSimulation } from '../../src/loader/simulation';

const ISL = 'l-sw-a--sw-b';
const base = {
  'node-count': 3,
  'vm-layout': 'two-plus-spare',
  'vm-load-gbps': 'line-rate',
  'read-pct': 70,
} as const;

type Dir = { from: string; to: string; gbps: number; capacityGbps: number; delayUs: number };
const links = (s: ReturnType<ReturnType<typeof loadSimulation>['sim']['tick']>) =>
  JSON.parse(String(s.devices.flows?.fields.links ?? '{}')) as Record<string, Dir[]>;
const vmGbps = (s: ReturnType<ReturnType<typeof loadSimulation>['sim']['tick']>, vm: string) =>
  Number(s.devices[vm]?.fields.throughputGbps ?? Number.NaN);

/** Pin node n's VLAN-A interface to eth3 (Switch B) and VLAN-B to eth2: every path crosses. */
function swap(sim: ReturnType<typeof loadSimulation>['sim'], n: number) {
  for (const [vnic, member] of [
    [`node-${n}.cvm.storage-a`, `node-${n}.eth3`],
    [`node-${n}.cvm.storage-b`, `node-${n}.eth2`],
  ] as const) {
    sim.applyAction({
      kind: 'vswitch.rebalance',
      target: `node-${n}.vs1`,
      params: { vnic, member },
    });
  }
}

describe('throughput model (emergent congestion)', () => {
  it('a line-rate VM is limited by its node NICs; latency follows from queue depth / rate', () => {
    const { sim } = loadSimulation({ topologyId: 't1-ahv-flasharray', options: base });
    const s = sim.tick(10);
    // Reads (70 %) fill both 50 Gb NICs inbound: 100 Gb read + 43 Gb write.
    expect(vmGbps(s, 'node-1.vm-1')).toBeCloseTo(142.9, 0);
    expect(Number(s.devices['node-1.vm-1']?.fields.readGbps)).toBeCloseTo(100, 0);
    const rx = links(s)['l-node-1.eth2--sw-a']?.find((d) => d.from === 'sw-a');
    expect(rx?.gbps).toBeCloseTo(50, 0);
    expect(rx?.delayUs).toBeGreaterThan(0);
    // The spare VM on node 3 offers nothing until it is powered on.
    expect(s.devices['node-3.vm-1']?.fields.throughputGbps).toBeUndefined();
  });

  it('MAC pinning, 4 IPs, every interface on the far switch: the ISL fills with three nodes', () => {
    const { sim } = loadSimulation({
      topologyId: 't1-ahv-flasharray',
      options: { ...base, 'vs1-bond-mode': 'balance-slb' },
    });
    sim.tick(3);
    sim.applyAction({ kind: 'power-on', target: 'node-3.vm-1' });
    sim.tick(5);
    expect(links(sim.getSnapshot())[ISL]?.every((d) => d.gbps < 1)).toBe(true);
    for (const n of [1, 2]) swap(sim, n);
    let s = sim.tick(10);
    const two = links(s)[ISL] ?? [];
    expect(Math.max(...two.map((d) => d.gbps))).toBeGreaterThan(120);
    expect(two.every((d) => d.delayUs === 0)).toBe(true);
    const before = vmGbps(s, 'node-1.vm-1');
    const latBefore = Number(s.devices['node-1.vm-1']?.fields.ioLatencyUs);
    swap(sim, 3);
    s = sim.tick(10);
    const three = links(s)[ISL] ?? [];
    // Offered about 214 Gb per direction against 200: the ISL runs at line rate with a queue.
    for (const d of three) {
      expect(d.gbps).toBeCloseTo(200, 0);
      expect(d.delayUs).toBeGreaterThan(0);
    }
    expect(vmGbps(s, 'node-1.vm-1')).toBeLessThan(before - 5);
    expect(Number(s.devices['node-1.vm-1']?.fields.ioLatencyUs)).toBeGreaterThan(latBefore);
    expect(sim.eventLog().some((e) => e.code === 'net.link.saturated' && e.deviceId === ISL)).toBe(
      true,
    );
    // The inspector's path detail shows every path crossing the ISL.
    const paths = JSON.parse(String(s.devices['node-1.vm-1']?.fields.flowPaths)) as {
      islPct: number;
      routes: { out: string }[];
    }[];
    expect(paths).toHaveLength(4);
    expect(paths.every((p) => p.islPct === 100)).toBe(true);
    expect(paths[0]?.routes[0]?.out).toMatch(/⇒ ISL ⇒/);
  });

  it('MAC pinning, 8 IPs: about half the IO crosses the ISL whatever the pinning, and it stays under line rate', () => {
    const { sim } = loadSimulation({
      topologyId: 't1-ahv-flasharray',
      options: { ...base, 'vs1-bond-mode': 'balance-slb', 'array-port-vlans': 'trunked' },
    });
    sim.tick(3);
    sim.applyAction({ kind: 'power-on', target: 'node-3.vm-1' });
    for (const n of [1, 2, 3]) swap(sim, n);
    const s = sim.tick(10);
    const isl = links(s)[ISL] ?? [];
    for (const d of isl) {
      expect(d.gbps).toBeGreaterThan(90);
      expect(d.gbps).toBeLessThan(200);
      expect(d.delayUs).toBe(0);
    }
    expect(vmGbps(s, 'node-1.vm-1')).toBeCloseTo(142.9, 0);
  });

  it('a lighter offered load runs uncongested at what it asks for', () => {
    const { sim } = loadSimulation({ topologyId: 't1-ahv-flasharray', options: base });
    sim.tick(3);
    sim.applyAction({
      kind: 'vm.set-load',
      target: 'node-1.vm-1',
      params: { gbps: 25, readPct: 50 },
    });
    const s = sim.tick(5);
    expect(vmGbps(s, 'node-1.vm-1')).toBeCloseTo(25, 0);
    expect(Number(s.devices['node-1.vm-1']?.fields.readGbps)).toBeCloseTo(12.5, 0);
  });
});
