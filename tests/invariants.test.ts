/**
 * Property tests (SPEC §7.1): random fail/recover sequences on each topology must keep the
 * cluster invariants. Skipped until the integrator wires `defaultSimulationFactory()`; the
 * arbitraries are exercised now so they stay valid against the real topologies.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ActionRequest } from '../src/engine/types';
import { defineScenario, type ScenarioStep } from '../src/scenarios/define';
import {
  always,
  ioNeverServedByFencedHost,
  noVmRunningTwice,
  zkQuorumUnique,
} from '../src/scenarios/helpers';
import { defaultSimulationFactory, runScenario } from '../src/scenarios/runner';
import { buildTopology, type TopologyId } from '../src/topologies';

const HORIZON = 300;

interface Targets {
  /** Devices that take `fail` / `recover`. */
  readonly devices: readonly string[];
  /** Links that take `link-down` / `link-up`. */
  readonly links: readonly string[];
}

const FAILABLE = new Set(['ahv-host', 'cvm', 'nic', 'switch', 'fa-controller', 'disk']);

/** Fault targets read from the built default topology, so they always match stream D's ids. */
function targetsOf(id: TopologyId): Targets {
  const t = buildTopology(id);
  return {
    devices: t.devices
      .filter((d) => FAILABLE.has(d.kind) && !(d.kind === 'nic' && d.id.startsWith('fa.')))
      .map((d) => d.id),
    links: t.links.map((l) => l.id),
  };
}

const actionArb = (t: Targets): fc.Arbitrary<ActionRequest> =>
  fc.oneof(
    fc.record({
      kind: fc.constantFrom('fail', 'recover'),
      target: fc.constantFrom(...t.devices),
    }),
    fc.record({
      kind: fc.constantFrom('link-down', 'link-up'),
      target: fc.constantFrom(...t.links),
    }),
  );

const timelineArb = (t: Targets): fc.Arbitrary<ScenarioStep[]> =>
  fc
    .array(fc.record({ at: fc.integer({ min: 0, max: HORIZON - 60 }), action: actionArb(t) }), {
      minLength: 1,
      maxLength: 8,
    })
    .map((steps) => [...steps].sort((a, b) => a.at - b.at));

const TOPOLOGIES: readonly TopologyId[] = [
  't1-ahv-flasharray',
  't2-hci-ahv',
  't3-co-so',
  't3-co-hci',
];

describe('invariant arbitraries', () => {
  it.each(TOPOLOGIES)('%s: generate fault timelines over real device and link ids', (id) => {
    const t = targetsOf(id);
    expect(t.devices.length).toBeGreaterThan(0);
    expect(t.links.length).toBeGreaterThan(0);
    const all = new Set([...t.devices, ...t.links]);
    fc.assert(
      fc.property(timelineArb(t), (steps) =>
        steps.every(
          (s, i) => all.has(s.action.target) && (i === 0 || (steps[i - 1]?.at ?? 0) <= s.at),
        ),
      ),
      { numRuns: 50 },
    );
  });
});

const factory = defaultSimulationFactory();
/** Topologies whose domain devices are modeled (SPEC §13 streams E/F/G). */
const DOMAIN_MODELS_READY: ReadonlySet<string> = new Set<string>([
  't1-ahv-flasharray',
  't2-hci-ahv',
  't3-co-so',
  't3-co-hci',
]);
/** Full domain simulations are heavier than placeholders; property runs need more time. */
const PROPERTY_TIMEOUT_MS = 120_000;

describe.skipIf(factory === undefined)('cluster invariants under random faults', () => {
  for (const id of TOPOLOGIES) {
    const t = targetsOf(id);
    const run = (timeline: ScenarioStep[], seed: number) => {
      if (!factory) throw new Error('no simulation factory');
      return runScenario(
        defineScenario({
          id: `fuzz-${id}`,
          title: `fuzz ${id}`,
          topology: id,
          seed,
          durationS: HORIZON,
          timeline,
          expect: [
            always('no VM runs on two hosts', noVmRunningTwice),
            always('IO is never served by a fenced host', ioNeverServedByFencedHost),
            always('at most one ZK quorum side', zkQuorumUnique),
          ],
          narrative: 'Random faults. Invariants must hold.',
          cite: [],
          status: 'active',
        }),
        factory,
        { keepHistory: false },
      );
    };

    // Needs the domain models (VM instances, fencing, quorum fields), composed by the loader.
    it.skipIf(!DOMAIN_MODELS_READY.has(id))(
      `${id}: invariants hold on every tick`,
      () => {
        fc.assert(
          fc.property(timelineArb(t), fc.integer({ min: 1, max: 1_000_000 }), (timeline, seed) => {
            expect(run(timeline, seed).failures).toEqual([]);
          }),
          { numRuns: 15 },
        );
      },
      PROPERTY_TIMEOUT_MS,
    );

    it(
      `${id}: same seed and actions give the same event codes`,
      () => {
        fc.assert(
          fc.property(timelineArb(t), fc.integer({ min: 1, max: 1_000_000 }), (timeline, seed) => {
            expect(run(timeline, seed).eventCodes).toEqual(run(timeline, seed).eventCodes);
          }),
          { numRuns: 6 },
        );
      },
      PROPERTY_TIMEOUT_MS,
    );
  }
});
