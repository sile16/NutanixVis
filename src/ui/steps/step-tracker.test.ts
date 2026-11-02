import { describe, expect, it } from 'vitest';
import { loadSimulation } from '../../loader/simulation';
import { STEP_QUANTUM_TICKS, StepTracker } from './step-tracker';

const OPTIONS = {
  'node-count': 3,
  'vm-layout': 'two',
  'storage-vswitch-layout': 'per-fabric',
} as const;

function setup() {
  const sim = loadSimulation({ topologyId: 't1-ahv-flasharray', options: OPTIONS, seed: 1 }).sim;
  const tracker = new StepTracker(sim);
  sim.tick(10);
  return { sim, tracker };
}

/** What the Step button does past the last stage: one tick at a time until the counter moves. */
function press(sim: ReturnType<typeof setup>['sim'], tracker: StepTracker, cap = 900): void {
  const before = tracker.view().current;
  for (let i = 0; i < cap; i++) {
    sim.tick(1);
    if (tracker.view().current !== before) return;
  }
}

describe('step counter past the last stage', () => {
  it('keeps counting, never regresses, and stays 0 while steady', () => {
    const { sim, tracker } = setup();
    for (let i = 0; i < 3; i++) press(sim, tracker, STEP_QUANTUM_TICKS + 2);
    expect(tracker.view().current).toBe(0);

    sim.applyAction({ kind: 'fail', target: 'node-1.eth2' });
    sim.applyAction({ kind: 'fail', target: 'node-1.eth3' });
    let prev = 0;
    for (let i = 0; i < 14; i++) {
      press(sim, tracker);
      const now = tracker.view().current;
      expect(now).toBeGreaterThanOrEqual(prev);
      if (i >= 4) expect(now).toBeGreaterThan(prev);
      prev = now;
    }
    expect(prev).toBeGreaterThanOrEqual(14);
    expect(tracker.view().stepOfTick(sim.getSnapshot().simTime)).toBe(prev);
  });

  it('restoring after the last stage still yields later steps with recovery events', () => {
    const { sim, tracker } = setup();
    sim.applyAction({ kind: 'fail', target: 'node-1.eth2' });
    sim.applyAction({ kind: 'fail', target: 'node-1.eth3' });
    for (let i = 0; i < 10; i++) press(sim, tracker);
    const atRestore = tracker.view().current;
    sim.applyAction({ kind: 'recover', target: 'node-1.eth2' });
    sim.applyAction({ kind: 'recover', target: 'node-1.eth3' });
    let prev = atRestore;
    for (let i = 0; i < 40; i++) {
      press(sim, tracker);
      const now = tracker.view().current;
      expect(now).toBeGreaterThanOrEqual(prev);
      prev = now;
    }
    expect(prev).toBeGreaterThan(atRestore);
    const t = sim.getSnapshot().simTime;
    expect(tracker.view().stepOfTick(t)).toBe(prev);
    const view = tracker.view();
    const vm = view.vms.get('node-1.vm-1');
    expect(vm?.milestones.some((m) => m.step > 4)).toBe(true);
  });
});

describe('failback span', () => {
  it('the long wait for the sessions to fail back is about four steps, then the counter stops', () => {
    const { sim, tracker } = setup();
    sim.applyAction({ kind: 'fail', target: 'node-1.eth2' });
    sim.applyAction({ kind: 'fail', target: 'node-1.eth3' });
    let restored = false;
    let restartedAt = -1;
    let failedBackAt = -1;
    for (let t = 0; t < 900; t++) {
      sim.tick(1);
      const v = tracker.view();
      const ms = v.vms.get('node-1.vm-1')?.milestones ?? [];
      if (!restored && ms.some((m) => m.stage === 'resumed')) {
        sim.applyAction({ kind: 'recover', target: 'node-1.eth2' });
        sim.applyAction({ kind: 'recover', target: 'node-1.eth3' });
        restored = true;
      }
      if (restartedAt < 0 && ms.some((m) => m.stage === 'services-restarted')) {
        restartedAt = v.current;
      }
      if (failedBackAt < 0 && ms.some((m) => m.stage === 'failed-back')) {
        failedBackAt = v.current;
        break;
      }
    }
    expect(restartedAt).toBeGreaterThan(0);
    expect(failedBackAt - restartedAt).toBe(4);
    // Once failed back, the counter no longer climbs.
    sim.tick(600);
    expect(tracker.view().current).toBe(failedBackAt);
  });
});
