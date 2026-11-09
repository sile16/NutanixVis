import { describe, expect, it } from 'vitest';
import { loadSimulation } from '../../loader/simulation';
import { pressStep } from './step-press';
import { StepTracker } from './step-tracker';

const CAPS = { active: 900, max: 20_000, quiet: 32, budgetMs: 60_000 };

function setup() {
  const sim = loadSimulation({
    topologyId: 't1-ahv-flasharray',
    options: { 'node-count': 3, 'vm-layout': 'two', 'storage-vswitch-layout': 'per-fabric' },
    seed: 1,
  }).sim;
  const steps = new StepTracker(sim);
  sim.tick(10);
  return { sim, steps };
}

const stagesOf = (steps: StepTracker, vm = 'node-1.vm-1'): string[] =>
  steps
    .view()
    .vms.get(vm)
    ?.milestones.map((m) => m.stage) ?? [];
const vmState = (sim: ReturnType<typeof setup>['sim'], vm = 'node-1.vm-1') => {
  const f = sim.getSnapshot().devices[vm]?.fields ?? {};
  return { state: f.state, stuck: f.stuckIoPct };
};

describe('a Step press runs through the next step', () => {
  it('one storage NIC: press 1 shows a partial stall, press 2 the IO resumed on the other NIC', () => {
    const { sim, steps } = setup();
    sim.applyAction({ kind: 'fail', target: 'node-1.eth2' });
    pressStep(sim, steps, CAPS);
    expect(steps.view().current).toBe(1);
    const mid = vmState(sim);
    expect(mid.state).toBe('running');
    expect(mid.stuck).toBeGreaterThan(0);
    expect(mid.stuck).toBeLessThan(100);
    expect(stagesOf(steps)).not.toContain('resumed');
    pressStep(sim, steps, CAPS);
    expect(steps.view().current).toBe(2);
    expect(stagesOf(steps)).toEqual(expect.arrayContaining(['path-rerouted', 'resumed']));
    expect(vmState(sim).stuck).toBe(0);
    expect(steps.view().settled).toBe(true);
  });

  it('both storage NICs: stalled through step 3, then maintenance, redirect and resume in step 4', () => {
    const { sim, steps } = setup();
    sim.applyAction({ kind: 'fail', target: 'node-1.eth2' });
    sim.applyAction({ kind: 'fail', target: 'node-1.eth3' });
    for (const n of [1, 2, 3]) {
      pressStep(sim, steps, CAPS);
      expect(steps.view().current).toBe(n);
      expect(vmState(sim)).toEqual({ state: 'io-stalled', stuck: 100 });
      expect(stagesOf(steps)).not.toContain('maintenance');
    }
    expect(stagesOf(steps)).toContain('all-paths-lost');
    pressStep(sim, steps, CAPS);
    expect(steps.view().current).toBe(4);
    expect(stagesOf(steps)).toEqual(
      expect.arrayContaining(['maintenance', 'services-stopped', 'redirected', 'resumed']),
    );
    expect(vmState(sim).state).toBe('running');
  });

  it('a quiet system only moves a few ticks per press', () => {
    const { sim, steps } = setup();
    const t = sim.getSnapshot().simTime;
    pressStep(sim, steps, CAPS);
    expect(sim.getSnapshot().simTime - t).toBe(CAPS.quiet);
    expect(steps.view().current).toBe(0);
  });
});
