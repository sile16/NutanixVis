/**
 * Stream H's acceptance scenarios that depend only on stream F behavior (AHV HA, redirector,
 * ZK / Cassandra, isolation, T3 roles), run headless through the real loader with fake storage
 * backends. Scenarios that also need E (NVMe paths, array) or G (rebuild, extent groups) are
 * covered once the integrator composes the real backends.
 */
import { describe, expect, it } from 'vitest';
import { scenarios } from '../../../src/scenarios/index';
import { runScenario, type SimulationFactory } from '../../../src/scenarios/runner';
import type { TopologyId } from '../../../src/topologies';
import { harness } from './harness';

const F_ONLY = [
  't1-07-host-power-loss',
  't2-03-host-isolation',
  't2-04-acropolis-leader-host-fails',
  't2-08-second-failure-after-rebuild',
  't2-10-block-failure-aware',
  't2-11-partition-3-2',
  't3-02-co-node-fails-co-so',
  't3-02-co-node-fails-co-hci',
  't3-04-co-all-uplinks-lost',
  't3-05-hci-vs-co-nic-failure',
  't3-07-co-ratio-advisory',
];

const factory: SimulationFactory = (req) =>
  harness(req.topology as TopologyId, req.options, req.seed).sim;

describe('stream H scenarios (F-only) with fake backends', () => {
  it('lists real scenario ids', () => {
    const ids = new Set(scenarios.map((s) => s.id));
    for (const id of F_ONLY) expect(ids.has(id), id).toBe(true);
  });
  for (const id of F_ONLY) {
    it(id, () => {
      const def = scenarios.find((s) => s.id === id);
      if (!def) throw new Error(id);
      expect(runScenario(def, factory).failures).toEqual([]);
    }, 60_000);
  }
});
