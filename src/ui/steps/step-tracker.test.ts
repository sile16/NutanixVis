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

describe('incidents', () => {
  it('a brief stall without a redirect stops the counter when IO resumes (settled)', () => {
    const { sim, tracker } = setup();
    sim.applyAction({ kind: 'fail', target: 'fa.ct0' });
    let settledAt = -1;
    for (let t = 0; t < 300 && settledAt < 0; t++) {
      sim.tick(1);
      if (tracker.view().current > 0 && tracker.view().settled) settledAt = tracker.view().current;
    }
    expect(settledAt).toBeGreaterThan(0);
    sim.tick(2000);
    expect(tracker.view().current).toBe(settledAt);
    expect(tracker.view().settled).toBe(true);
  });

  it('after a settled incident, a new action restarts the counter at 0 and earlier events keep their steps', () => {
    const { sim, tracker } = setup();
    sim.applyAction({ kind: 'fail', target: 'fa.ct0' });
    sim.tick(300);
    const first = tracker.view();
    expect(first.settled).toBe(true);
    const old = first.current;
    expect(old).toBeGreaterThan(0);
    const failT = sim.eventLog().find((e) => e.code === 'device.failed')?.t ?? -1;
    const oldStep = first.stepOfTick(failT + 5);
    // A failure that interrupts no VM: the counter reads 0 (steady), time still moves.
    tracker.beginIncidentIfSettled(sim.getSnapshot().simTime);
    sim.applyAction({ kind: 'fail', target: 'node-1.host-mgmt' });
    const t0 = sim.getSnapshot().simTime;
    sim.tick(64);
    expect(sim.getSnapshot().simTime).toBe(t0 + 64);
    expect(tracker.view().current).toBe(0);
    expect(tracker.view().stepOfTick(failT + 5)).toBe(oldStep);
    // A new interruption counts from step 1 again.
    sim.applyAction({ kind: 'recover', target: 'fa.ct0' });
    sim.tick(400);
    tracker.beginIncidentIfSettled(sim.getSnapshot().simTime);
    sim.applyAction({ kind: 'fail', target: 'fa.ct1' });
    let firstSeen = 0;
    for (let t = 0; t < 40 && firstSeen === 0; t++) {
      sim.tick(1);
      firstSeen = tracker.view().current;
    }
    expect(firstSeen).toBe(1);
  });

  it('a failed VM counts as an interruption: the counter advances', () => {
    const { sim, tracker } = setup();
    sim.applyAction({ kind: 'fail', target: 'node-1.vm-1' });
    sim.tick(30);
    expect(tracker.view().current).toBeGreaterThanOrEqual(2);
  });
});
