import { describe, expect, it } from 'vitest';
import { loadSimulation } from '../../loader/simulation';
import { linkUsageLabels } from './link-usage';
import { buildMeters } from './meters';
import { bondUtilization } from './path-usage';

const OPTIONS = {
  'node-count': 3,
  'vm-layout': 'two-plus-spare',
  'vm-load-gbps': 'line-rate',
  'read-pct': 70,
  'vs1-bond-mode': 'balance-slb',
} as const;
const run = (extra: Record<string, string> = {}) =>
  loadSimulation({ topologyId: 't1-ahv-flasharray', options: { ...OPTIONS, ...extra } }).sim;
const pct = (x: number | undefined) => Math.round((x ?? 0) * 100);

describe('speed labels and throughput meters', () => {
  it('cable labels are speeds with arrows as drawn: hosts send ↓, the array sends ↑', () => {
    const s = run().tick(10);
    const labels = linkUsageLabels(s);
    // Host NIC: sends 21 Gb of writes down, receives 50 Gb of reads (full) up.
    expect(labels.get('l-node-1.eth2--sw-a')?.text).toMatch(/^↓21 ↑50 Gb · full \+\d+ µs$/);
    expect(labels.get('l-fa.ct0.eth10--sw-a')?.text).toMatch(/^↑\d+ ↓\d+ Gb$/);
    expect(labels.get('l-sw-a--sw-b')?.text).toMatch(/^→\d+ ←\d+ Gb\n\d+% of storage IO crosses$/);
  });

  it('line-rate bars: each direction as a share of the cable line rate', () => {
    const m = buildMeters(run().tick(10));
    const eth2 = m.line.get('node-1.eth2');
    expect(eth2?.capacityGbps).toBe(50);
    expect(eth2?.dirs.map((d) => [d.arrow, pct(d.util), d.tone])).toEqual([
      ['↓', 43, 'ok'],
      ['↑', 100, 'full'],
    ]);
    expect(m.line.get('l-sw-a--sw-b')?.dirs.map((d) => d.arrow)).toEqual(['→', '←']);
  });

  it('bond distribution: 50/50, then 100% on eth3 once eth2 fails', () => {
    const sim = run();
    let m = buildMeters(sim.tick(10));
    expect(m.bond.get('node-1.vs1')?.map((x) => [x.label, pct(x.share)])).toEqual([
      ['eth2', 50],
      ['eth3', 50],
    ]);
    sim.applyAction({ kind: 'fail', target: 'node-1.eth2' });
    m = buildMeters(sim.tick(5));
    expect(m.bond.get('node-1.vs1')?.map((x) => [x.label, pct(x.share)])).toEqual([
      ['eth2', 0],
      ['eth3', 100],
    ]);
    const vs1 = bondUtilization(sim.getSnapshot(), 'node-1').find(
      (b) => b.vswitchId === 'node-1.vs1',
    );
    expect(vs1?.basis).toBe('throughput');
    expect(vs1?.members.map((x) => pct(x.share))).toEqual([0, 100]);
  });

  it('Stargate distribution: its storage interfaces, summed over the VMs it serves', () => {
    const m = buildMeters(run().tick(10));
    const sg = m.stargate.get('node-1.cvm.stargate');
    expect(sg?.map((x) => x.id)).toEqual(['node-1.cvm.storage-a', 'node-1.cvm.storage-b']);
    expect(sg?.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 5);
    // Node 3's spare VM is off: its Stargate serves nothing, so it has no bar.
    expect(m.stargate.has('node-3.cvm.stargate')).toBe(false);
  });

  it('workload.set-iops sets every VM to that many IOs of the model IO size', () => {
    const sim = run();
    sim.tick(3);
    sim.applyAction({ kind: 'workload.set-iops', target: 'cluster', params: { iops: 5000 } });
    const s = sim.tick(5);
    for (const vm of ['node-1.vm-1', 'node-2.vm-1']) {
      expect(s.devices[vm]?.fields.offeredIops).toBe(5000);
      expect(Number(s.devices[vm]?.fields.iops)).toBeCloseTo(5000, -1);
      expect(Number(s.devices[vm]?.fields.throughputGbps)).toBeCloseTo(10.5, 0);
    }
  });
});
