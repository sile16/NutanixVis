import { describe, expect, it } from 'vitest';
import { loadSimulation } from '../../loader/simulation';
import { StepTracker } from './step-tracker';

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

/** Ticks (since the failure) at which the counter first reached each step. */
function stepStarts(run: (t: number) => void, tracker: StepTracker, ticks: number): number[] {
  const starts: number[] = [];
  let prev = 0;
  for (let t = 1; t <= ticks; t++) {
    run(t);
    const now = tracker.view().current;
    for (let k = prev + 1; k <= now; k++) starts[k] = t;
    prev = Math.max(prev, now);
  }
  return starts;
}

describe('step counter on the relative scale', () => {
  it('stays 0 while steady and never regresses', () => {
    const { sim, tracker } = setup();
    sim.tick(200);
    expect(tracker.view().current).toBe(0);
    sim.applyAction({ kind: 'fail', target: 'node-1.eth2' });
    sim.applyAction({ kind: 'fail', target: 'node-1.eth3' });
    let prev = 0;
    for (let t = 0; t < 400; t++) {
      sim.tick(1);
      const now = tracker.view().current;
      expect(now).toBeGreaterThanOrEqual(prev);
      prev = now;
    }
    expect(prev).toBeGreaterThan(3);
    expect(tracker.view().stepOfTick(sim.getSnapshot().simTime)).toBe(prev);
  });

  it('is not linear: each step takes longer than the one before', () => {
    const { sim, tracker } = setup();
    sim.applyAction({ kind: 'fail', target: 'node-1.eth2' });
    sim.applyAction({ kind: 'fail', target: 'node-1.eth3' });
    const starts = stepStarts(() => sim.tick(1), tracker, 300);
    const gaps: number[] = [];
    for (let k = 2; k < starts.length - 1; k++) {
      gaps.push((starts[k + 1] as number) - (starts[k] as number));
    }
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i] as number).toBeGreaterThanOrEqual((gaps[i - 1] as number) * 1.5);
    }
  });
});

describe('failback span', () => {
  it('the long wait for the sessions to fail back spans a handful of steps, then the counter stops', () => {
    const { sim, tracker } = setup();
    sim.applyAction({ kind: 'fail', target: 'node-1.eth2' });
    sim.applyAction({ kind: 'fail', target: 'node-1.eth3' });
    let restored = false;
    let resumedAt = -1;
    let failedBackAt = -1;
    for (let t = 0; t < 900; t++) {
      sim.tick(1);
      const v = tracker.view();
      const ms = v.vms.get('node-1.vm-1')?.milestones ?? [];
      if (!restored && ms.some((m) => m.stage === 'resumed')) {
        sim.applyAction({ kind: 'recover', target: 'node-1.eth2' });
        sim.applyAction({ kind: 'recover', target: 'node-1.eth3' });
        restored = true;
        resumedAt = v.current;
      }
      if (failedBackAt < 0 && ms.some((m) => m.stage === 'failed-back')) {
        failedBackAt = v.current;
        break;
      }
    }
    expect(resumedAt).toBeGreaterThan(0);
    // The failover happens in the first few steps; recovering takes a handful more.
    expect(failedBackAt - resumedAt).toBeGreaterThanOrEqual(3);
    expect(failedBackAt - resumedAt).toBeLessThanOrEqual(6);
    sim.tick(600);
    expect(tracker.view().current).toBe(failedBackAt);
  });
});
