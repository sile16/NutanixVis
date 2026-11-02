import { describe, expect, it } from 'vitest';
import { matrix } from '../../domain/versions';
import { loadSimulation } from '../../loader/simulation';
import { catalog } from '../app/catalog';
import { defaultVersions, toVersionSelection } from '../app/versions';
import { bondMoves, buildImpact } from '../steps/impact';
import { StepTracker } from '../steps/step-tracker';
import { buildDataPath, hopFlows, hopLinks, isIoLink, placeDataPath } from './data-path';

const run = (options: Record<string, string> = {}) => {
  const { sim } = loadSimulation({ topologyId: 't1-ahv-flasharray', options });
  const steps = new StepTracker(sim);
  sim.tick(20);
  return { sim, steps };
};
const hop = (m: ReturnType<typeof buildDataPath>, from: string, to: string) =>
  m.hops.find((h) => h.from === from && h.to === to);

describe('I/O data path (T1)', () => {
  it('draws VM -> redirector -> Stargate -> interface -> vswitch -> NIC, active in steady state', () => {
    const { sim } = run();
    const s = sim.getSnapshot();
    const m = buildDataPath(s);
    expect(m.enabled).toBe(true);
    expect(hop(m, 'node-1.vm-1', 'node-1.redirector')?.state).toBe('active');
    expect(hop(m, 'node-1.redirector', 'node-1.cvm.stargate')?.state).toBe('active');
    expect(hop(m, 'node-1.cvm.stargate', 'node-1.cvm.storage-a')?.state).toBe('active');
    expect(hop(m, 'node-1.cvm.storage-a', 'node-1.vs1')?.state).toBe('active');
    expect(hop(m, 'node-1.vs1', 'node-1.eth1')?.state).toBe('active');
    expect(hop(m, 'node-1.vs0', 'node-1.eth2')?.state).toBe('standby');
    expect(Object.keys(m.devices)).toContain('node-1.cvm.stargate');
    // every hop is an I/O link with its own port ids, and only active hops animate
    expect(Object.keys(hopLinks(m)).every(isIoLink)).toBe(true);
    expect(
      hopFlows(m).every(
        (f) => hop(m, ...(f.linkId.slice(3).split('>') as [string, string]))?.state === 'active',
      ),
    ).toBe(true);
  });

  it('places the derived boxes in the rows the topology layout reserves', () => {
    const { sim } = run();
    const s = sim.getSnapshot();
    const m = buildDataPath(s);
    const layout = {
      'node-1.vm-1': { x: 0, y: 0, w: 100, h: 40 },
      'node-1.cvm.storage-a': { x: 0, y: 100, w: 80, h: 20 },
    };
    const out = placeDataPath(m, s.devices, layout);
    const sg = out.layout['node-1.cvm.stargate'];
    const rd = out.layout['node-1.redirector'];
    expect(sg && sg.y + (sg.h ?? 0) < 100).toBe(true);
    expect(rd && rd.y >= 40).toBe(true);
  });

  it('both storage NICs down: the bond and its interfaces are down, the VM edges stall', () => {
    const { sim } = run();
    sim.applyAction({ kind: 'fail', target: 'node-1.eth1' });
    sim.applyAction({ kind: 'fail', target: 'node-1.eth3' });
    sim.tick(4);
    const m = buildDataPath(sim.getSnapshot());
    expect(hop(m, 'node-1.vs1', 'node-1.eth1')?.state).toBe('down');
    expect(hop(m, 'node-1.vs1', 'node-1.eth3')?.state).toBe('down');
    expect(hop(m, 'node-1.cvm.storage-a', 'node-1.vs1')?.state).toBe('down');
    expect(hop(m, 'node-1.vm-1', 'node-1.redirector')?.state).toBe('stalled');
    expect(hop(m, 'node-2.vs1', 'node-2.eth1')?.state).toBe('active');
  });

  it('bond member loss: traffic moves to the surviving NIC with no stalled step', () => {
    const { sim, steps } = run({
      'storage-vlans': 'single',
      'vlan-placement': 'tagged-both',
      'isl-storage-vlans': 'allowed',
    });
    sim.applyAction({ kind: 'fail', target: 'node-1.eth1' });
    sim.tick(60);
    const s = sim.getSnapshot();
    const m = buildDataPath(s);
    expect(hop(m, 'node-1.vs1', 'node-1.eth1')?.state).toBe('down');
    expect(hop(m, 'node-1.vs1', 'node-1.eth3')?.state).toBe('active');
    expect(m.notes.get('node-1.eth3')?.text).toBe('active');
    const impact = buildImpact(steps.view(), s);
    expect(impact.steps).toBe(0);
    expect(impact.rows).toEqual([]);
    expect(impact.bondMoves.join(' ')).toContain('traffic moved to eth3');
    expect(bondMoves(s)).toHaveLength(1);
  });

  it('impact strip: stalled steps come before the redirect step, and the order holds', () => {
    const { sim, steps } = run();
    sim.applyAction({ kind: 'fail', target: 'node-1.eth1' });
    sim.applyAction({ kind: 'fail', target: 'node-1.eth3' });
    sim.tick(120);
    const s = sim.getSnapshot();
    const impact = buildImpact(steps.view(), s);
    const row = impact.rows.find((r) => r.vm === 'node-1.vm-1');
    expect(row).toBeDefined();
    const kinds = row?.cells.map((c) => c.kind) ?? [];
    expect(kinds[0]).toBe('normal');
    const firstStall = kinds.indexOf('stalled');
    const firstRedirect = kinds.indexOf('redirected');
    expect(firstStall).toBeGreaterThan(0);
    expect(firstRedirect).toBeGreaterThan(firstStall);
    expect(row?.cells[firstRedirect]?.text).toMatch(/^via CVM/);
    expect(impact.unaffected).toBe(6);
    // the redirected path leaves through the management uplink to the other CVM
    const m = buildDataPath(s);
    expect(hop(m, 'node-1.redirector', 'node-1.host-mgmt')?.redirected).toBe(true);
  });

  it('bonded single-network variant: two live array paths per CVM, the other portals not connected', () => {
    const entry = catalog.find((e) => e.id === 't1-bonded-single');
    expect(entry).toBeDefined();
    if (!entry) throw new Error('catalog entry missing');
    const sim = entry.createSimulation(toVersionSelection(matrix, defaultVersions(matrix), true));
    const steps = new StepTracker(sim);
    sim.tick(60);
    const s = sim.getSnapshot();
    const paths = JSON.parse(String(s.devices['node-1.cvm']?.fields.nvmePaths)) as Record<
      string,
      string
    >;
    expect(Object.values(paths)).toEqual(['live', 'live']);
    const m = buildDataPath(s);
    expect(m.notes.get('fa.ct0.eth11.v10')?.text).toBe('not connected (by design)');
    expect(m.notes.get('fa.ct1.eth11.v10')?.text).toBe('not connected (by design)');
    expect(m.notes.get('fa.ct0.eth10.v10')?.text).not.toBe('not connected (by design)');
    // the unconnected portals are expected: no path was ever lost, no VM is affected
    expect(sim.eventLog().some((e) => e.code === 'nvme.path.lost')).toBe(false);
    expect(buildImpact(steps.view(), s).steps).toBe(0);
    // both storage NICs down: every remaining path is lost, the VM stalls then is redirected
    sim.applyAction({ kind: 'fail', target: 'node-1.eth1' });
    sim.applyAction({ kind: 'fail', target: 'node-1.eth3' });
    sim.tick(120);
    const after = sim.getSnapshot();
    const impact = buildImpact(steps.view(), after);
    expect(impact.rows.some((r) => r.vm === 'node-1.vm-1')).toBe(true);
  });
});
