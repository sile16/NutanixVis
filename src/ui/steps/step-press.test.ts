import { describe, expect, it } from 'vitest';
import { stepBoundary } from '../../domain/steps';
import { loadSimulation } from '../../loader/simulation';
import { PressRunner, pressStep, StepPress } from './step-press';
import { StepTracker } from './step-tracker';

const CAPS = { active: 900, max: 60_000, quiet: 32 };

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

  it('planned controller reboot: no VM stalls, the counter runs drain, reboot, back online', () => {
    const { sim, steps } = setup();
    sim.applyAction({ kind: 'fa.controller.reboot', target: 'fa.ct1' });
    const ctrl = () => sim.getSnapshot().devices['fa.ct1']?.fields.state;
    pressStep(sim, steps, CAPS);
    expect(steps.view().current).toBe(1);
    expect(ctrl()).toBe('draining');
    pressStep(sim, steps, CAPS);
    expect(steps.view().current).toBe(2);
    expect(ctrl()).toBe('rebooting');
    for (const n of [3, 4]) {
      pressStep(sim, steps, CAPS);
      expect(steps.view().current).toBe(n);
      expect(ctrl()).toBe('rebooting');
    }
    pressStep(sim, steps, CAPS);
    expect(steps.view().current).toBe(5);
    expect(ctrl()).toBe('up');
    expect(steps.view().settled).toBe(true);
    for (const v of steps.view().vms.values()) expect(v.startT).toBeNull();
  });

  it('a quiet system only moves a few ticks per press', () => {
    const { sim, steps } = setup();
    const t = sim.getSnapshot().simTime;
    pressStep(sim, steps, CAPS);
    expect(sim.getSnapshot().simTime - t).toBe(CAPS.quiet);
    expect(steps.view().current).toBe(0);
  });

  it('a press stops when the incident settles inside its step, not after its whole wait', () => {
    const { sim, steps } = setup();
    const act = (kind: string, target: string) => {
      steps.beginIncidentIfSettled(sim.getSnapshot().simTime);
      sim.applyAction({ kind, target });
      sim.tick(1);
    };
    act('reboot', 'node-1.cvm');
    for (let i = 0; i < 4; i++) pressStep(sim, steps, CAPS);
    act('fail', 'node-2.vm-1');
    pressStep(sim, steps, CAPS);
    pressStep(sim, steps, CAPS);
    // node-1 failed back; only node-2.vm-1 is open, and it waits on the user.
    expect(steps.view().waiting).toBe(true);
    act('recover', 'node-2.vm-1');
    const t0 = sim.getSnapshot().simTime;
    pressStep(sim, steps, CAPS);
    expect(steps.view().settled).toBe(true);
    expect(sim.getSnapshot().simTime - t0).toBeLessThanOrEqual(CAPS.quiet);
  });

  it('each press runs to the end of its step, however long the step is', () => {
    const { sim, steps } = setup();
    sim.applyAction({ kind: 'reboot', target: 'node-1.cvm' });
    sim.tick(1);
    const start = () => Math.min(...steps.view().runs.map((r) => r.startT ?? Infinity));
    for (let n = 1; n < 12; n++) {
      pressStep(sim, steps, CAPS);
      const v = steps.view();
      const t = sim.getSnapshot().simTime;
      expect(v.current).toBeGreaterThanOrEqual(n);
      // Unless the incident settled in it, the press stopped on the last tick of the step shown.
      if (v.settled) break;
      expect(t + 1).toBe(start() + stepBoundary(v.current + 1));
    }
    expect(steps.view().settled).toBe(true);
    expect(steps.view().current).toBeGreaterThanOrEqual(6);
  });

  it('a run waiting on the user stops a press at once; later presses are quiet', () => {
    const { sim, steps } = setup();
    sim.applyAction({ kind: 'fail', target: 'node-1.cvm' });
    for (let i = 0; i < 6 && !steps.view().waiting; i++) pressStep(sim, steps, CAPS);
    expect(steps.view().waiting).toBe(true);
    const at = steps.view().current;
    const t0 = sim.getSnapshot().simTime;
    pressStep(sim, steps, CAPS);
    expect(sim.getSnapshot().simTime - t0).toBe(CAPS.quiet);
    expect(steps.view().current).toBe(at);
  });

  it('the runner slices a press across frames, is busy meanwhile, ignores re-presses', () => {
    const { sim, steps } = setup();
    sim.applyAction({ kind: 'reboot', target: 'node-1.cvm' });
    for (let i = 0; i < 5; i++) pressStep(sim, steps, CAPS);
    // Reference: the same press run at once on a twin simulation.
    const twin = setup();
    twin.sim.applyAction({ kind: 'reboot', target: 'node-1.cvm' });
    for (let i = 0; i < 6; i++) pressStep(twin.sim, twin.steps, CAPS);

    let clock = 0;
    const frames: (() => void)[] = [];
    const runner = new PressRunner({
      syncMs: 0,
      frameMs: 1,
      now: () => clock++,
      schedule: (cb) => frames.push(cb),
    });
    const busy: boolean[] = [];
    runner.subscribe(() => busy.push(runner.busy));
    let progress = 0;
    expect(runner.start(new StepPress(sim, steps, CAPS), () => progress++)).toBe(true);
    expect(runner.busy).toBe(true);
    expect(runner.start(new StepPress(sim, steps, CAPS), () => {})).toBe(false);
    let n = 0;
    while (frames.length > 0 && n++ < 10_000) frames.shift()?.();
    expect(runner.busy).toBe(false);
    expect(busy).toEqual([true, false]);
    expect(progress).toBeGreaterThan(1);
    expect(sim.getSnapshot().simTime).toBe(twin.sim.getSnapshot().simTime);
    expect(steps.view().current).toBe(twin.steps.view().current);
  });

  it('cancel stops a running press where it is', () => {
    const { sim, steps } = setup();
    sim.applyAction({ kind: 'reboot', target: 'node-1.cvm' });
    for (let i = 0; i < 5; i++) pressStep(sim, steps, CAPS);
    let clock = 0;
    const frames: (() => void)[] = [];
    const runner = new PressRunner({
      syncMs: 0,
      frameMs: 1,
      now: () => clock++,
      schedule: (cb) => frames.push(cb),
    });
    runner.start(new StepPress(sim, steps, CAPS), () => {});
    frames.shift()?.();
    const t = sim.getSnapshot().simTime;
    runner.cancel();
    expect(runner.busy).toBe(false);
    while (frames.length > 0) frames.shift()?.();
    expect(sim.getSnapshot().simTime).toBe(t);
  });
});
