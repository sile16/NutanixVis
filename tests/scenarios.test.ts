/**
 * Scenario acceptance tests (SPEC §7.1). Every scenario is statically validated against the real
 * topologies, profile and citation registry; `todo` scenarios register as `it.todo` and `active`
 * ones run through `runScenario` with the injected simulation factory.
 */
import { describe, expect, it } from 'vitest';
import { citations } from '../src/domain/citations';
import type {
  ActionRequest,
  DeviceView,
  SimEvent,
  Simulation,
  Snapshot,
} from '../src/engine/types';
import { evaluate, withCtx } from '../src/scenarios/context';
import { defineScenario, type ScenarioDef } from '../src/scenarios/define';
import { always, at, atCtx, eventSeen, eventsInOrder, wasEver } from '../src/scenarios/helpers';
import { backlogRef, type ScenarioFamily, scenarios } from '../src/scenarios/index';
import {
  defaultSimulationFactory,
  runScenario,
  type SimulationFactory,
  scenarioDuration,
} from '../src/scenarios/runner';
import { buildTopology, isTopologyId } from '../src/topologies';

// ── Registry and static validation ───────────────────────────────────────────

/** SPEC §7.2 backlog sizes. */
const BACKLOG: Readonly<Record<ScenarioFamily, number>> = { t1: 26, t2: 13, t3: 7, t1lab: 4 };

const ACTION_KINDS = new Set([
  'fail',
  'recover',
  'power-off',
  'reboot',
  'link-down',
  'link-up',
  'set-latency',
  'fa.controller.failover',
  'fa.ndu',
  'fa.io-stall',
  'fa.interface.disable',
  'fa.interface.enable',
  'cvm.stop-stargate',
  'host.isolate',
  'disk.fail',
  'switch.fail',
  'switch.port.prune-vlan',
  'switch.hang',
  'vswitch.set-bond-mode',
  'vswitch.set-uplinks',
  'vswitch.set-lacp-rate',
  'fabric.set-mlag',
  'fabric.set-vlan-placement',
  'link.flap',
  'link.set-loss',
  'fa.interface.flap',
  'cvm.network-flap',
  'cvm.mark-fixed',
  'power-on',
  'switch.port.allow-vlan',
]);
/** Proposed by stream H, pending the integrator (see docs/view-fields.md "Proposals"). */
const PROPOSED_ACTIONS = new Set(['vm.snapshot', 'vswitch.rebalance']);
const PROPOSED_OPTIONS = new Set(['path-loss-force-shutdown-s']);

const scenarioFiles = import.meta.glob<{ default: ScenarioDef | readonly ScenarioDef[] }>(
  '../src/scenarios/{t1,t2,t3,t1-lab}/[0-9]*.ts',
  { eager: true },
);

function sentences(text: string): number {
  return text.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((x) => x.trim().length > 0).length;
}

describe('scenario registry', () => {
  it('has unique, well-formed ids', () => {
    const ids = scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(backlogRef(id), id).not.toBeNull();
  });

  it('covers every SPEC §7.2 backlog item', () => {
    for (const [family, size] of Object.entries(BACKLOG)) {
      const items = new Set(
        scenarios
          .map((s) => backlogRef(s.id))
          .flatMap((r) => (r?.family === family ? [r.item] : [])),
      );
      for (let i = 1; i <= size; i++) expect(items.has(i), `${family} item ${i}`).toBe(true);
    }
  });

  it('registers every scenario file', () => {
    const fromFiles = Object.values(scenarioFiles).flatMap((m) =>
      Array.isArray(m.default) ? m.default : [m.default as ScenarioDef],
    );
    expect(fromFiles.length).toBeGreaterThan(0);
    const registered = new Set(scenarios.map((s) => s.id));
    for (const def of fromFiles) expect(registered.has(def.id), def.id).toBe(true);
    expect(fromFiles.length).toBe(scenarios.length);
  });
});

describe.each(scenarios.map((s) => [s.id, s] as const))('scenario %s', (_id, def) => {
  it('targets a known topology, valid options and existing devices/links', () => {
    expect(isTopologyId(def.topology), def.topology).toBe(true);
    if (!isTopologyId(def.topology)) return;
    const options = Object.fromEntries(
      Object.entries(def.options ?? {}).filter(([k]) => !PROPOSED_OPTIONS.has(k)),
    );
    const topo = buildTopology(def.topology, options);
    const ids = new Set([...topo.devices.map((d) => d.id), ...topo.links.map((l) => l.id)]);
    for (const step of def.timeline) {
      const kind = step.action.kind;
      expect(ACTION_KINDS.has(kind) || PROPOSED_ACTIONS.has(kind), `action ${kind}`).toBe(true);
      expect(ids.has(step.action.target), `target ${step.action.target}`).toBe(true);
    }
  });

  it('has a coherent timeline and expectations', () => {
    const end = scenarioDuration(def);
    for (const step of def.timeline) {
      expect(step.at).toBeGreaterThanOrEqual(0);
      expect(step.at).toBeLessThan(end);
    }
    for (const e of def.expect) {
      if ('at' in e) {
        expect(e.at, e.label).toBeGreaterThanOrEqual(0);
        expect(e.at, e.label).toBeLessThanOrEqual(end);
      }
    }
    expect(def.expect.length).toBeGreaterThan(0);
  });

  it('cites registered public sources and has a 2–4 sentence narrative', () => {
    expect(def.cite.length).toBeGreaterThan(0);
    for (const c of def.cite) expect(citations[c], c).toBeDefined();
    const n = sentences(def.narrative);
    expect(n, def.narrative).toBeGreaterThanOrEqual(2);
    expect(n, def.narrative).toBeLessThanOrEqual(4);
  });
});

// ── Acceptance runs ──────────────────────────────────────────────────────────

const factory = defaultSimulationFactory();

describe('scenario acceptance', () => {
  for (const def of scenarios) {
    if (def.status === 'todo' || factory === undefined) {
      it.todo(`${def.id}: ${def.title}`);
      continue;
    }
    it(`${def.id}: ${def.title}`, () => {
      const result = runScenario(def, factory);
      expect(result.failures).toEqual([]);
      expect(result.eventCodes).toMatchSnapshot();
    });
  }
});

// ── Runner self-tests (fake simulation) ──────────────────────────────────────

/** One device `x` whose field `v` counts applied `bump` actions; emits a timer event at t=5. */
class FakeSim implements Simulation {
  private t = 0;
  private seq = 0;
  private value = 0;
  private queue: ActionRequest[] = [];
  private log: SimEvent[] = [];
  private snap: Snapshot;

  constructor(private readonly seed: number) {
    this.snap = this.build([]);
  }

  getSnapshot(): Snapshot {
    return this.snap;
  }
  subscribe(): () => void {
    return () => {};
  }
  applyAction(action: ActionRequest): void {
    this.queue.push(action);
  }
  tick(n = 1): Snapshot {
    for (let i = 0; i < n; i++) {
      this.t++;
      const events: SimEvent[] = [];
      for (const a of this.queue) {
        if (a.kind === 'bump') {
          this.value++;
          events.push(this.event('fake.bumped', a.target));
        }
      }
      this.queue = [];
      if (this.t === 5) events.push(this.event('fake.timer'));
      this.log.push(...events);
      this.snap = this.build(events);
    }
    return this.snap;
  }
  runUntilNextTimer(): Snapshot {
    return this.tick();
  }
  availableActions(): readonly [] {
    return [];
  }
  eventLog(): readonly SimEvent[] {
    return this.log;
  }

  private event(code: string, deviceId?: string): SimEvent {
    return {
      seq: this.seq++,
      t: this.t,
      severity: 'info',
      code,
      text: code,
      causeIds: [],
      cite: [],
      ...(deviceId !== undefined ? { deviceId } : {}),
    };
  }

  private build(events: readonly SimEvent[]): Snapshot {
    const x: DeviceView = {
      id: 'x',
      kind: 'fake',
      label: 'x',
      status: 'healthy',
      badges: [],
      fields: { v: this.value },
    };
    return {
      version: this.t,
      simTime: this.t,
      seed: this.seed,
      topologyId: 'fake',
      versions: { nutanix: 'n', profileId: 'p' },
      devices: { x },
      links: {},
      traces: [],
      events,
      derived: {},
      nextTimerAt: null,
    };
  }
}

const fakeFactory: SimulationFactory = (req) => new FakeSim(req.seed);
const v = (s: Snapshot): number => Number(s.devices.x?.fields.v);
const bump = (t: number) => ({ at: t, action: { kind: 'bump', target: 'x' } });

function fake(partial: Partial<ScenarioDef>): ScenarioDef {
  return defineScenario({
    id: 'fake',
    title: 'fake',
    topology: 'fake',
    timeline: [],
    expect: [],
    narrative: 'Fake. Scenario.',
    cite: [],
    status: 'active',
    ...partial,
  });
}

describe('runScenario', () => {
  it('applies a step queued at t on snapshot t+1 and checks `at` on exactly that tick', () => {
    const r = runScenario(
      fake({
        timeline: [bump(3)],
        expect: [
          at(3, 'not yet applied at t=3', (s) => v(s) === 0),
          at(4, 'applied at t=4', (s) => v(s) === 1),
        ],
      }),
      fakeFactory,
    );
    expect(r.failures).toEqual([]);
    expect(r.final.simTime).toBe(14);
    expect(r.ticks).toBe(14);
  });

  it('checks `always` on every tick and reports only the first failing tick', () => {
    let calls = 0;
    const r = runScenario(
      fake({
        timeline: [bump(3)],
        durationS: 8,
        expect: [
          always('v stays 0', (s) => {
            calls++;
            return v(s) === 0;
          }),
        ],
      }),
      fakeFactory,
    );
    expect(r.failures).toEqual([
      { label: 'v stays 0', kind: 'always', t: 4, reason: 'predicate returned false' },
    ]);
    expect(calls).toBe(5);
  });

  it('accumulates events across ticks for context predicates', () => {
    const r = runScenario(
      fake({
        timeline: [bump(3)],
        expect: [
          atCtx(9, 'bump seen earlier', (_s, ctx) =>
            eventSeen(ctx, 'fake.bumped', { device: 'x' }),
          ),
          atCtx(9, 'order', (_s, ctx) =>
            eventsInOrder(ctx, [{ code: 'fake.bumped' }, { code: 'fake.timer' }]),
          ),
          atCtx(
            9,
            'history',
            (_s, ctx) => wasEver(ctx, (s) => v(s) === 0) && ctx.history.length === 10,
          ),
          atCtx(2, 'not seen before it happens', (_s, ctx) => !eventSeen(ctx, 'fake.bumped')),
        ],
      }),
      fakeFactory,
    );
    expect(r.failures).toEqual([]);
  });

  it('returns the golden event-code list', () => {
    const r = runScenario(fake({ timeline: [bump(3)], durationS: 6 }), fakeFactory);
    expect(r.eventCodes).toEqual(['4\tfake.bumped@x', '5\tfake.timer']);
  });

  it('reports throwing predicates, unevaluated expectations and unapplied steps', () => {
    const r = runScenario(
      fake({
        durationS: 5,
        timeline: [bump(7)],
        expect: [
          at(2, 'throws', () => {
            throw new Error('boom');
          }),
          at(9, 'too late', () => true),
        ],
      }),
      fakeFactory,
    );
    expect(r.failures.map((f) => [f.label, f.reason])).toEqual([
      ['throws', 'threw: boom'],
      ['too late', 'never evaluated: due after t=5'],
      ['timeline step at t=7 never applied', 'scenario ends at t=5'],
    ]);
  });

  it('defaults the duration to the last step or expectation + 10', () => {
    expect(scenarioDuration(fake({ timeline: [bump(3)], expect: [at(20, 'x', () => true)] }))).toBe(
      30,
    );
    expect(scenarioDuration(fake({ timeline: [bump(3)] }))).toBe(13);
  });

  it('is deterministic for the same seed', () => {
    const def = fake({ timeline: [bump(1), bump(2)] });
    expect(runScenario(def, fakeFactory).eventCodes).toEqual(
      runScenario(def, fakeFactory).eventCodes,
    );
  });
});

describe('withCtx', () => {
  it('passes the runner context, and falls back to a one-tick context when called directly', () => {
    const sim = new FakeSim(1);
    sim.applyAction({ kind: 'bump', target: 'x' });
    const s = sim.tick();
    const pred = withCtx((_s, ctx) => ctx.events.length > 0);
    const lenPred = withCtx((snap, ctx) => ctx.events.length === 1 && ctx.history[0] === snap);
    expect(pred(s)).toBe(true);
    expect(lenPred(s)).toBe(true);
    expect(evaluate(pred, s, { now: 1, events: [], history: [s] })).toBe(false);
  });
});
