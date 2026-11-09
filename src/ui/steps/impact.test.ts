import { describe, expect, it } from 'vitest';
import { stepAt } from '../../domain/steps';
import { loadSimulation } from '../../loader/simulation';
import { buildImpact, ImpactCache, impactCacheFor } from './impact';
import type { StepSample, StepsView } from './step-tracker';
import { StepTracker } from './step-tracker';

function setup(options: Record<string, unknown> = {}) {
  const sim = loadSimulation({
    topologyId: 't1-ahv-flasharray',
    options: {
      'node-count': 3,
      'vm-layout': 'two',
      'storage-vswitch-layout': 'per-fabric',
      ...options,
    } as never,
    seed: 1,
  }).sim;
  const steps = new StepTracker(sim);
  sim.tick(10);
  return { sim, steps };
}

const act = (s: ReturnType<typeof setup>, kind: string, target: string): void => {
  s.steps.beginIncidentIfSettled(s.sim.getSnapshot().simTime);
  s.sim.applyAction({ kind, target });
  s.sim.tick(1);
};

const rowOf = (s: ReturnType<typeof setup>, vm: string) =>
  buildImpact(s.steps.view(), s.sim.getSnapshot()).rows.find((r) => r.vm === vm);

/** A hand-made view: one run from tick 10, samples for one VM. */
function synthetic(samples: StepSample[], endT: number | null): StepsView {
  const run = { startT: 10, endT, holds: [] };
  const last = samples[samples.length - 1]?.t ?? 0;
  const view: StepsView = {
    vms: new Map(),
    array: { startT: null, endT: null, holds: [], milestones: [], crashed: false },
    runs: [run],
    samples: new Map([['v', samples]]),
    from: 0,
    current: stepAt(run, last),
    settled: endT !== null,
    waiting: false,
    stepOfTick: (t) => stepAt(run, t),
    counting: (t) => t < 10 || (t >= 10 && (endT === null || t <= endT)),
  };
  return view;
}

const s = (t: number, state: string, pend = 0, host = 'n1', owner = 'n1.cvm'): StepSample => ({
  t,
  state,
  ioPendingS: pend,
  host,
  ownerCvm: owner,
});

describe('impact strip model', () => {
  it('a stall that begins and ends inside one step still shows in that step (worst state)', () => {
    // Step 2 is ticks 20–29: stalled at 22–25 only, running again by the step's end.
    const samples = Array.from({ length: 50 }, (_, t) =>
      t >= 10 && t < 13
        ? s(t, 'io-stalled', 3)
        : t >= 22 && t < 26
          ? s(t, 'io-stalled', 3)
          : s(t, 'running'),
    );
    const m = buildImpact(synthetic(samples, null), { devices: {}, links: [] } as never);
    const row = m.rows[0];
    expect(row?.cells.map((c) => c.kind)).toEqual(['normal', 'stalled', 'stalled', 'recovered']);
    expect(row?.now).toBeNull();
    expect(row?.stalledSteps).toBe(2);
  });

  it('a VM the user powered off is no interruption and has no row', () => {
    const x = setup();
    act(x, 'power-off', 'node-2.vm-1');
    x.sim.tick(60);
    act(x, 'fail', 'fa.ct0');
    x.sim.tick(60);
    const m = buildImpact(x.steps.view(), x.sim.getSnapshot());
    expect(m.rows.map((r) => r.vm)).not.toContain('node-2.vm-1');
  });

  it('a host power-off: down, then restarted by AHV HA on another host, never "via CVM"', () => {
    const x = setup();
    act(x, 'power-off', 'node-1');
    x.sim.tick(300);
    const row = rowOf(x, 'node-1.vm-1');
    expect(row).toBeDefined();
    const kinds = new Set(row?.cells.map((c) => c.kind));
    expect(kinds.has('down')).toBe(true);
    expect(kinds.has('redirected')).toBe(false);
    expect(kinds.has('stalled')).toBe(false);
    expect(row?.cells.some((c) => c.text === 'restarting')).toBe(true);
    expect(row?.summary).toMatch(/^down \d+ steps?, restarted by AHV HA on /);
    expect(row?.now?.kind).toBe('recovered');
  });

  it('host maintenance (live migration) does not read as a redirect', () => {
    const x = setup();
    act(x, 'host.enter-maintenance', 'node-1');
    x.sim.tick(200);
    const m = buildImpact(x.steps.view(), x.sim.getSnapshot());
    expect(m.rows).toEqual([]);
  });

  it('waiting for recovery: the steps stop and a "now" cell shows the VM served remotely', () => {
    const x = setup();
    act(x, 'fail', 'node-1.cvm');
    x.sim.tick(200);
    const m = buildImpact(x.steps.view(), x.sim.getSnapshot());
    expect(m.now).toBe('waiting');
    const row = m.rows.find((r) => r.vm === 'node-1.vm-1');
    expect(row?.now?.kind).toBe('redirected');
    expect(row?.now?.text).toMatch(/^via /);
    expect(row?.summary).toMatch(/then redirected$/);
  });

  it('a failed VM reads "down", waiting for recovery, not "all IO stalled"', () => {
    const x = setup();
    act(x, 'fail', 'node-1.vm-1');
    x.sim.tick(100);
    const row = rowOf(x, 'node-1.vm-1');
    expect(row?.cells.at(-1)?.kind).toBe('down');
    expect(row?.cells.filter((c) => !c.now).map((c) => c.kind)).toEqual(['normal', 'down']);
    expect(row?.cells.some((c) => c.text === 'all IO stalled')).toBe(false);
    expect(row?.summary).toBe('down 1 step, waiting for recovery');
  });

  it('the cached build matches a fresh one on every tick, and stays cheap', () => {
    const x = setup();
    act(x, 'reboot', 'node-1.cvm');
    const cache = new ImpactCache();
    for (let t = 0; t < 600; t++) {
      x.sim.tick(1);
      if (t % 7 !== 0) continue;
      const v = x.steps.view();
      const snap = x.sim.getSnapshot();
      expect(buildImpact(v, snap, cache)).toEqual(buildImpact(v, snap));
    }
    const v = x.steps.view();
    expect(impactCacheFor(v)).toBe(impactCacheFor(v));
  });
});
