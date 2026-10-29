import { describe, expect, it } from 'vitest';
import { loadSimulation } from '../src/loader/simulation';

const kinds = (sim: ReturnType<typeof loadSimulation>['sim'], id: string) =>
  sim.availableActions(id).map((a) => a.kind);

describe('action applicability and MLAG pairing (UI bug-hunt findings)', () => {
  it('enabling MLAG on an unpaired switch pairs it with its ISL peer; disabling twice is a no-op', () => {
    const { sim } = loadSimulation({ topologyId: 't1-ahv-flasharray' }); // mlag off by default
    sim.tick(1);
    sim.applyAction({ kind: 'fabric.set-mlag', target: 'sw-a', params: { enabled: 'on' } });
    let s = sim.tick(1);
    expect(s.devices['sw-a']?.fields.mlagDomain).toBe('mlag:sw-a+sw-b');
    expect(s.devices['sw-b']?.fields.mlagDomain).toBe('mlag:sw-a+sw-b');
    expect(sim.eventLog().some((e) => e.code === 'action.rejected')).toBe(false);

    const { sim: fresh } = loadSimulation({ topologyId: 't1-ahv-flasharray' });
    fresh.applyAction({ kind: 'fabric.set-mlag', target: 'sw-a', params: { enabled: 'off' } });
    s = fresh.tick(1);
    expect(fresh.eventLog().some((e) => e.code === 'net.mlag.changed')).toBe(false);
    expect(fresh.eventLog().some((e) => e.code === 'action.rejected')).toBe(false);
  });

  it('VLAN-aware member selection is only offered for MAC pinning and active-backup bonds', () => {
    const { sim } = loadSimulation({ topologyId: 't1-ahv-flasharray' });
    sim.tick(1);
    expect(kinds(sim, 'node-1.vs1')).toContain('vswitch.set-slb-vlan-aware');
    sim.applyAction({
      kind: 'vswitch.set-bond-mode',
      target: 'node-1.vs1',
      params: { mode: 'balance-tcp' },
    });
    sim.tick(1);
    expect(kinds(sim, 'node-1.vs1')).not.toContain('vswitch.set-slb-vlan-aware');
  });

  it('Start Stargate is only offered when Stargate is not up', () => {
    const { sim } = loadSimulation({ topologyId: 't2-hci-ahv' });
    sim.tick(2);
    expect(kinds(sim, 'node-1.cvm')).not.toContain('cvm.start-stargate');
    sim.applyAction({ kind: 'cvm.stop-stargate', target: 'node-1.cvm' });
    sim.tick(2);
    expect(kinds(sim, 'node-1.cvm')).toContain('cvm.start-stargate');
  });

  it('Hang / resume / crash Stargate are offered only in the matching state', () => {
    const { sim } = loadSimulation({ topologyId: 't2-hci-ahv' });
    sim.tick(2);
    expect(kinds(sim, 'node-1.cvm')).toContain('cvm.hang-stargate');
    expect(kinds(sim, 'node-1.cvm')).toContain('cvm.crash-stargate');
    expect(kinds(sim, 'node-1.cvm')).not.toContain('cvm.resume-stargate');
    sim.applyAction({ kind: 'cvm.hang-stargate', target: 'node-1.cvm' });
    sim.tick(1);
    expect(kinds(sim, 'node-1.cvm')).toContain('cvm.resume-stargate');
    expect(kinds(sim, 'node-1.cvm')).not.toContain('cvm.hang-stargate');
    expect(kinds(sim, 'node-1.cvm')).not.toContain('cvm.start-stargate');
  });
});
