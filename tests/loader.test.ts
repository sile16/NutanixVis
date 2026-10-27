import { describe, expect, it } from 'vitest';
import { loadSimulation } from '../src/loader/simulation';
import { type TopologyId, topologies } from '../src/topologies';

const ids = Object.keys(topologies) as TopologyId[];

describe('loadSimulation', () => {
  it.each(ids)('%s loads, ticks and views every topology device', (topologyId) => {
    const { sim, topology, versions } = loadSimulation({ topologyId });
    const s = sim.tick(3);
    expect(s.simTime).toBe(3);
    expect(s.topologyId).toBe(topologyId);
    for (const d of topology.devices) expect(s.devices[d.id], d.id).toBeDefined();
    for (const l of topology.links) expect(s.links[l.id]?.status, l.id).toBe('up');
    const hasArray = topology.devices.some((d) => d.kind === 'fa-array');
    expect(versions.flasharray !== undefined).toBe(hasArray);
  });

  it('defaults to the newest versions and the current profile', () => {
    const { versions } = loadSimulation({ topologyId: 't1-ahv-flasharray' });
    expect(versions.selection.profileId).toBe('current');
    expect(versions.selection.flasharray).toBeDefined();
  });

  it('failing a switch takes its links down', () => {
    const { sim } = loadSimulation({ topologyId: 't1-ahv-flasharray' });
    sim.applyAction({ kind: 'fail', target: 'sw-a' });
    const s = sim.tick();
    expect(s.devices['sw-a']?.status).toBe('failed');
    expect(s.links['l-node-1.eth1--sw-a']?.status).toBe('down');
  });

  it('failing a host takes its NICs down with it', () => {
    const { sim } = loadSimulation({ topologyId: 't2-hci-ahv' });
    sim.applyAction({ kind: 'fail', target: 'node-1' });
    const s = sim.tick();
    expect(s.devices['node-1.eth0']?.status).not.toBe('healthy');
  });

  it('is deterministic for a seed', () => {
    const run = () => {
      const { sim } = loadSimulation({ topologyId: 't3-co-so', seed: 7 });
      sim.applyAction({ kind: 'fail', target: 'sw-b' });
      sim.tick(5);
      return sim.eventLog().map((e) => e.code);
    };
    expect(run()).toEqual(run());
  });
});
