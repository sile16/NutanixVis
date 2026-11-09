import { describe, expect, it } from 'vitest';
import { loadSimulation } from '../../loader/simulation';
import { effectiveDevices } from '../diagram/effective-status';
import { isOfferedAction } from './offered-actions';

const SPARE = { 'node-count': 3, 'vm-layout': 'two-plus-spare' } as const;

/** What the inspector offers on `id`: applicable, not hidden, and sensible for the drawn state. */
function offered(sim: ReturnType<typeof loadSimulation>['sim'], id: string): string[] {
  const view = effectiveDevices(sim.getSnapshot().devices)[id];
  return sim
    .availableActions(id)
    .filter((s) => isOfferedAction(s, view))
    .map((s) => s.kind);
}

describe('offered actions', () => {
  it('a powered-off VM offers power-on, not fail', () => {
    const { sim } = loadSimulation({ topologyId: 't1-ahv-flasharray', options: SPARE });
    sim.tick(2);
    const kinds = offered(sim, 'node-3.vm-1');
    expect(kinds).toContain('power-on');
    expect(kinds).not.toContain('fail');
    expect(offered(sim, 'node-1.vm-1')).toContain('fail');
  });

  it('a powered-off host: its CVM offers no power-on and its bonds no bond changes', () => {
    const { sim } = loadSimulation({ topologyId: 't1-ahv-flasharray', options: SPARE });
    sim.tick(2);
    const bonds = offered(sim, 'node-1.vs1').filter((k) => k.startsWith('vswitch.'));
    expect(bonds.length).toBeGreaterThan(0);
    sim.applyAction({ kind: 'power-off', target: 'node-1' });
    sim.tick(2);
    expect(offered(sim, 'node-1')).toContain('power-on');
    expect(offered(sim, 'node-1.cvm')).not.toContain('power-on');
    expect(sim.availableActions('node-1.cvm').map((s) => s.kind)).not.toContain('power-on');
    expect(offered(sim, 'node-1.vs1').filter((k) => k.startsWith('vswitch.'))).toEqual([]);
    // A CVM powered off on its own still powers on.
    sim.applyAction({ kind: 'power-on', target: 'node-1' });
    sim.applyAction({ kind: 'power-off', target: 'node-2.cvm' });
    sim.tick(2);
    expect(offered(sim, 'node-2.cvm')).toContain('power-on');
  });
});
