import { describe, expect, it } from 'vitest';
import { loadSimulation } from '../../loader/simulation';
import type { OptionValues } from '../../topologies/options';
import { islLinks } from './isl-share';
import { islWhy } from './isl-why';

function why(options: OptionValues, act?: (sim: ReturnType<typeof loadSimulation>['sim']) => void) {
  const { sim } = loadSimulation({ topologyId: 't1-ahv-flasharray', options, seed: 1 });
  sim.tick(20);
  act?.(sim);
  sim.tick(5);
  const s = sim.getSnapshot();
  const isl = islLinks(s)[0] ?? '';
  return islWhy(s, isl).join('\n');
}

describe('ISL hover explanation', () => {
  it('MAC pinning at home: every interface local', () => {
    const t = why({ 'storage-vswitch-layout': 'single-bond' });
    expect(t).toMatch(/8 of 8 pinned storage interfaces .* stay local/);
    expect(t).toMatch(/Nothing needs the ISL/);
  });

  it('MAC pinning with an interface moved to the other switch: names it and says both directions', () => {
    const t = why({ 'storage-vswitch-layout': 'single-bond' }, (sim) =>
      sim.applyAction({ kind: 'fail', target: 'node-1.eth2' }),
    );
    expect(t).toMatch(/7 of 8/);
    expect(t).toMatch(/both directions/);
    expect(t).toMatch(/CVM 1 .* on eth3 \(Switch B/);
  });

  it('LACP over MLAG: host-to-array hashing, replies stay local', () => {
    const t = why({ 'storage-vswitch-layout': 'single-bond', 'vs1-bond-mode': 'balance-tcp' });
    expect(t).toMatch(/about half of the writes/);
    expect(t).toMatch(/replies don't cross/);
  });

  it('trunked array ports: about half of each interface crosses', () => {
    const t = why({ 'storage-vswitch-layout': 'single-bond', 'array-port-vlans': 'trunked' });
    expect(t).toMatch(/both switches \(trunked array ports\)/);
  });

  it('per-fabric no-bond: nothing needs the ISL', () => {
    const t = why({ 'storage-vswitch-layout': 'per-fabric' });
    expect(t).toMatch(/Nothing needs the ISL/);
  });
});
