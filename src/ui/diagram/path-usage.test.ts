import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../engine/types';
import { t1Frames } from '../../fixtures/snapshots/t1-frames';
import { loadSimulation } from '../../loader/simulation';
import type { TopologyId } from '../../topologies';
import { SnapshotHistory } from '../store/snapshot-history';
import { buildActivityWindow } from './activity-window';
import { bondUtilization, computePathUsage } from './path-usage';

/** A real simulation run for `ticks`, as the diagram's 10-tick activity window sees it. */
function window10(topologyId: TopologyId, ticks = 12) {
  const { sim } = loadSimulation({
    topologyId,
    versions: {
      nutanix: 'aos-7.6',
      ...(topologyId.startsWith('t1') ? { flasharray: 'purity-6.12' } : {}),
    },
  });
  const h = new SnapshotHistory(sim);
  sim.tick(ticks);
  return buildActivityWindow(h.last(10));
}

const linkEnds = (s: Snapshot, ids: Iterable<string>) =>
  [...ids].flatMap((id) => {
    const l = s.links[id];
    return l ? [l.a.device, l.b.device] : [];
  });

describe('computePathUsage per VM (ioPaths / ioUplinks)', () => {
  it('T3 CO: a VM counts only the IO to its own owning CVM', () => {
    const w = window10('t3-co-so');
    const a = computePathUsage(w.snapshot, 'node-1.vm-1', w.vmPaths.get('node-1.vm-1'));
    const b = computePathUsage(w.snapshot, 'node-1.vm-2', w.vmPaths.get('node-1.vm-2'));
    expect(a?.scope).toBe('vm');
    const ownerA = String(w.snapshot.devices['node-1.vm-1']?.fields.ownerCvm);
    const ownerB = String(w.snapshot.devices['node-1.vm-2']?.fields.ownerCvm);
    expect(ownerA).not.toBe(ownerB);
    const hostA = ownerA.replace(/\.cvm$/, '');
    const hostB = ownerB.replace(/\.cvm$/, '');
    // Each VM's far end is its own owner's node, never the other VM's.
    expect(a?.targets.every((t) => t.deviceId.startsWith(`${hostA}.`))).toBe(true);
    expect(b?.targets.every((t) => t.deviceId.startsWith(`${hostB}.`))).toBe(true);
    expect(linkEnds(w.snapshot, a?.linkIds ?? []).some((d) => d.startsWith(`${hostB}.`))).toBe(
      false,
    );
    expect(a?.traceCount).toBeGreaterThan(0);
  });

  it('T1: a VM counts only NVMe/TCP traces on its own paths', () => {
    const w = window10('t1-ahv-flasharray');
    const io = w.vmPaths.get('node-1.vm-1');
    expect(io?.paths.size).toBeGreaterThan(0);
    const u = computePathUsage(w.snapshot, 'node-1.vm-1', io);
    expect(u?.scope).toBe('vm');
    const perHost = computePathUsage(w.snapshot, 'node-1.vm-1');
    // Per host also counts keep-alives, NOPs and the other VM's IO.
    expect(u?.traceCount).toBeLessThan(perHost?.traceCount ?? 0);
    expect(u?.targets.every((t) => t.deviceId.startsWith('fa.'))).toBe(true);
    expect(u?.uplinks.every((s) => s.deviceId.startsWith('node-1.'))).toBe(true);
  });

  it('falls back to per host for an HCI VM served locally over virbr0', () => {
    const w = window10('t2-hci-ahv');
    const u = computePathUsage(w.snapshot, 'node-1.vm-1', w.vmPaths.get('node-1.vm-1'));
    expect(u?.scope).toBe('host');
    expect(u?.cvmId).toBe('node-1.cvm');
  });

  it('uses the host a VM runs on now (after an HA restart)', () => {
    const s = t1Frames.steady;
    const vm = s.devices['node-2.vm-1'];
    if (!vm) throw new Error('fixture');
    const moved: Snapshot = {
      ...s,
      devices: { ...s.devices, [vm.id]: { ...vm, fields: { ...vm.fields, host: 'node-1' } } },
    };
    expect(computePathUsage(moved, 'node-2.vm-1')?.hostId).toBe('node-1');
  });
});

describe('bondUtilization on the engine view (kind "bond")', () => {
  it('finds the host bonds of a real topology', () => {
    const w = window10('t1-ahv-flasharray');
    const bonds = bondUtilization(w.snapshot, 'node-1');
    expect(bonds.map((b) => b.vswitchId)).toEqual(['node-1.vs0', 'node-1.vs1']);
    expect(bonds[1]?.members.map((m) => m.nicId)).toEqual(['node-1.eth1', 'node-1.eth3']);
  });
});

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
