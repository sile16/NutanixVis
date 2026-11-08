import { describe, expect, it } from 'vitest';
import { loadSimulation } from '../../loader/simulation';
import { islLabel, islShares } from './isl-share';

const BOND = { 'node-count': 3, 'vm-layout': 'two', 'storage-vswitch-layout': 'single-bond' };
/** ISL share over the next `n` ticks (the diagram reads a rolling window too). */
const windowShare = (sim: ReturnType<typeof loadSimulation>['sim'], n = 20) => {
  const snaps = Array.from({ length: n }, () => sim.tick(1));
  const last = snaps[snaps.length - 1] ?? sim.getSnapshot();
  return islShares({ ...last, traces: snaps.flatMap((x) => x.traces) })[0];
};
const share = (options: Record<string, string | number | boolean>, ticks = 30) => {
  const { sim } = loadSimulation({ topologyId: 't1-ahv-flasharray', options });
  sim.tick(ticks);
  return { sim, isl: windowShare(sim) };
};

describe('ISL share of storage IO', () => {
  it('per-fabric with access array ports: storage stays off the ISL (0%)', () => {
    const { isl } = share({ ...BOND, 'storage-vswitch-layout': 'per-fabric' });
    expect(isl?.linkId).toBe('l-sw-a--sw-b-1');
    expect(isl?.total).toBeGreaterThan(0);
    expect(isl?.count).toBe(0);
    expect(isl && islLabel(isl)).toBe('ISL · 0% of storage IO');
  });

  it('MAC pinning, access array ports: 0% while each interface is pinned to its own VLAN’s switch', () => {
    const { sim, isl } = share({ ...BOND, 'vs1-bond-mode': 'balance-slb' });
    const pin = (seg: string) =>
      (
        JSON.parse(String(sim.getSnapshot().devices['node-1.vs1']?.fields.pinning)) as Record<
          string,
          string
        >
      )[seg];
    expect(pin('node-1.cvm.storage-a')).toBe('node-1.eth2');
    expect(pin('node-1.cvm.storage-b')).toBe('node-1.eth3');
    expect(isl?.total).toBeGreaterThan(0);
    expect(isl?.count).toBe(0);
  });

  it('MAC pinning: a storage NIC down moves the VLAN-A interface to Switch B, so its IO crosses the ISL', () => {
    const { sim } = share({ ...BOND, 'vs1-bond-mode': 'balance-slb' });
    sim.applyAction({ kind: 'fail', target: 'node-1.eth2' });
    sim.tick(30);
    const after = windowShare(sim);
    expect(after?.total).toBeGreaterThan(0);
    expect(after?.share).toBeGreaterThan(0);
    expect(after?.share).toBeLessThan(1);
  });

  it('LACP, access array ports: connections hash across both members, so some IO crosses the ISL', () => {
    const { isl } = share({ ...BOND, 'vs1-bond-mode': 'balance-tcp', mlag: true });
    expect(isl?.share).toBeGreaterThan(0);
    expect(isl?.share).toBeLessThan(1);
  });

  it('MAC pinning, trunked array ports (8 IPs): half the IO crosses the ISL, before and after a NIC loss', () => {
    // Each interface has four portals in its VLAN, two per switch, and active-active multipathing
    // spreads IO over all four, so pinning no longer decides the share.
    const { sim, isl } = share({
      ...BOND,
      'vs1-bond-mode': 'balance-slb',
      'array-port-vlans': 'trunked',
    });
    expect(isl?.share).toBeCloseTo(0.5, 2);
    sim.applyAction({ kind: 'fail', target: 'node-1.eth2' });
    sim.tick(30);
    expect(windowShare(sim)?.share).toBeCloseTo(0.5, 2);
  });

  it('no ISL, no label: a topology without a switch pair has no entry', () => {
    const { sim } = loadSimulation({ topologyId: 't1-ahv-flasharray', options: BOND });
    sim.tick(1);
    const snap = sim.getSnapshot();
    const noIsl = {
      ...snap,
      links: Object.fromEntries(
        Object.entries(snap.links).filter(([id]) => !id.startsWith('l-sw-a--sw-b')),
      ),
    };
    expect(islShares(noIsl)).toEqual([]);
  });
});
