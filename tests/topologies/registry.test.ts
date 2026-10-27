import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  builders,
  buildTopology,
  type Choice,
  defaultOptionValues,
  optionPatch,
  optionValuesOf,
  type TopologyId,
  topologies,
  topologyIds,
} from '../../src/topologies';
import { TopologySchema } from '../../src/topologies/schema';
import {
  conventionProblems,
  faProblems,
  layoutProblems,
  linkProblems,
  ofKind,
  reachabilityProblems,
  roleProblems,
  structuralProblems,
} from './invariants';

const all = topologyIds.map((id) => [id, topologies[id]] as const);

describe('registry', () => {
  it('registers exactly the shared topology ids', () => {
    expect(Object.keys(topologies).sort()).toEqual(
      ['t1-ahv-flasharray', 't1-lab', 't2-hci-ahv', 't3-co-hci', 't3-co-so'].sort(),
    );
  });

  it.each(all)('%s parses and matches its id', (id, t) => {
    expect(t.id).toBe(id);
    expect(TopologySchema.safeParse(t).success).toBe(true);
  });

  it.each(all)('%s default equals builders[id]() and the declared defaults', (id, t) => {
    expect(builders[id]()).toEqual(t);
    expect(optionValuesOf(t)).toEqual(defaultOptionValues(id));
  });

  it.each(all)('%s options: unique ids, defaults within choices', (_id, t) => {
    const ids = t.options.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const o of t.options) expect(o.choices).toContain(o.default);
  });
});

describe('default configuration invariants', () => {
  it.each(all)('%s ids follow the conventions', (_id, t) => {
    expect(conventionProblems(t)).toEqual([]);
  });
  it.each(all)('%s link ends are NICs or switches', (_id, t) => {
    expect(linkProblems(t)).toEqual([]);
  });
  it.each(all)('%s host roles: CVM / VM / disk rules', (_id, t) => {
    expect(roleProblems(t)).toEqual([]);
  });
  it.each(all)(
    '%s every CVM interface VLAN is reachable (and storage reaches both CTs)',
    (_id, t) => {
      expect(reachabilityProblems(t)).toEqual([]);
    },
  );
  it.each(all)('%s layout covers every device, nested and non-overlapping', (_id, t) => {
    expect(layoutProblems(t)).toEqual([]);
  });
  it.each(all.filter(([, t]) => ofKind(t, 'fa-array').length))(
    '%s FA has interfaces on every storage VLAN on both controllers',
    (_id, t) => {
      expect(faProblems(t)).toEqual([]);
    },
  );
});

/** Random option combination for a topology, drawn from its declared choices. */
function valuesArb(id: TopologyId) {
  const rec: Record<string, fc.Arbitrary<Choice>> = {};
  for (const o of topologies[id].options) rec[o.id] = fc.constantFrom(...o.choices);
  return fc.record(rec);
}

/** T2 rejects RF3 below 5 nodes by design. */
const buildable = (id: TopologyId, v: Record<string, Choice>) =>
  !(id === 't2-hci-ahv' && v['replication-factor'] === 3 && Number(v['node-count']) < 5);

describe('every option combination', () => {
  it.each(topologyIds)('%s: any variant is structurally valid', (id) => {
    fc.assert(
      fc.property(valuesArb(id), (v) => {
        if (!buildable(id, v)) return;
        expect(structuralProblems(buildTopology(id, v))).toEqual([]);
      }),
      { numRuns: 60 },
    );
  });

  it.each(topologyIds)('%s: runtime options only patch fields, never structure or layout', (id) => {
    const runtime = topologies[id].options.filter((o) => o.runtime);
    fc.assert(
      fc.property(valuesArb(id), (v) => {
        if (!buildable(id, v)) return;
        const current = buildTopology(id, v);
        for (const o of runtime) {
          for (const choice of o.choices) {
            const { next, diff } = optionPatch(id, current, o.id, choice);
            expect(diff.devices.added).toEqual([]);
            expect(diff.devices.removed).toEqual([]);
            expect(diff.links.added).toEqual([]);
            expect(diff.links.removed).toEqual([]);
            expect(diff.vlans.added).toEqual([]);
            expect(diff.layout.changed).toEqual({});
            expect(optionValuesOf(next)[o.id]).toBe(choice);
          }
        }
      }),
      { numRuns: 15 },
    );
  });
});

describe('builders validate params', () => {
  it('rejects values outside an option’s choices and unknown options', () => {
    expect(() => buildTopology('t1-ahv-flasharray', { 'node-count': 2 })).toThrow(/node-count/);
    expect(() => buildTopology('t1-ahv-flasharray', { 'no-such-option': true })).toThrow(
      /unknown option/,
    );
  });
});
