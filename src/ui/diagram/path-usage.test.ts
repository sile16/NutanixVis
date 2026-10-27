import { describe, expect, it } from 'vitest';
import { t1Frames } from '../../fixtures/snapshots/t1-frames';
import { bondUtilization, computePathUsage } from './path-usage';

describe('computePathUsage', () => {
  it('finds the owning CVM, the four NVMe paths and an even uplink split (steady)', () => {
    const u = computePathUsage(t1Frames.steady, 'node-2.vm-1');
    expect(u?.cvmId).toBe('node-2.cvm');
    expect(u?.hostId).toBe('node-2');
    expect(u?.uplinks.map((s) => [s.label, s.share])).toEqual([
      ['Node 2 eth1', 0.4],
      ['Node 2 eth3', 0.6],
    ]);
    expect(u?.targets.map((s) => s.label)).toEqual([
      'CT0 eth10',
      'CT0 eth11',
      'CT1 eth10',
      'CT1 eth11',
    ]);
    expect(u?.linkIds.has('l-n2-eth1')).toBe(true);
    expect(u?.linkIds.has('l-n1-eth1')).toBe(false);
    expect(u?.deviceIds.has('node-2.vs1')).toBe(true);
    expect(u?.deviceIds.has('node-2.vs0')).toBe(false);
  });

  it('moves all IO to the surviving fabric after Switch A fails', () => {
    const u = computePathUsage(t1Frames.fabricB, 'node-1.vm-2');
    expect(u?.uplinks.map((s) => s.label)).toEqual(['Node 1 eth3']);
    expect(u?.targets.map((s) => s.label)).toEqual(['CT0 eth11', 'CT1 eth11']);
  });

  it('returns null for non-VMs', () => {
    expect(computePathUsage(t1Frames.steady, 'sw-a')).toBeNull();
  });
});

describe('bondUtilization', () => {
  it('reports per-member utilization from LinkView.util', () => {
    const [vs0, vs1] = bondUtilization(t1Frames.steady, 'node-1');
    expect(vs0?.label).toBe('vs0');
    expect(vs1?.bondMode).toBe('balance-slb');
    expect(vs1?.members.map((m) => [m.label, m.total, m.share])).toEqual([
      ['eth1', 12, 0.5],
      ['eth3', 12, 0.5],
    ]);
    const after = bondUtilization(t1Frames.fabricB, 'node-1')[1];
    expect(after?.members.map((m) => [m.label, m.status, m.share])).toEqual([
      ['eth1', 'down', 0],
      ['eth3', 'up', 1],
    ]);
  });
});
