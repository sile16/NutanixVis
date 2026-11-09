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
    // A CVM reboot recovers on its own, so the counter climbs all the way to the failback.
    sim.applyAction({ kind: 'reboot', target: 'node-1.cvm' });
    const starts = stepStarts(() => sim.tick(1), tracker, 450);
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

  it('a failed VM is an interruption that waits on the user: step 1 until it is recovered', () => {
    const { sim, tracker } = setup();
    sim.applyAction({ kind: 'fail', target: 'node-1.vm-1' });
    sim.tick(300);
    let v = tracker.view();
    expect(v.current).toBe(1);
    expect(v.waiting).toBe(true);
    expect(v.settled).toBe(false);
    expect(v.vms.get('node-1.vm-1')?.impact).toBe('down');
    sim.applyAction({ kind: 'recover', target: 'node-1.vm-1' });
    sim.tick(5);
    v = tracker.view();
    expect(v.settled).toBe(true);
    expect(v.current).toBe(1);
  });
});

/** An action the way the UI applies one. */
const act = (
  sim: ReturnType<typeof setup>['sim'],
  tracker: StepTracker,
  kind: string,
  target: string,
) => {
  tracker.beginIncidentIfSettled(sim.getSnapshot().simTime);
  sim.applyAction({ kind, target });
  sim.tick(1);
};

describe('HA restarts, repeated interruptions, waiting for recovery', () => {
  it('a host that powers off: AHV HA restarts its VMs elsewhere and the incident settles there', () => {
    const { sim, tracker } = setup();
    act(sim, tracker, 'power-off', 'node-1');
    let settledAt = -1;
    for (let t = 0; t < 400 && settledAt < 0; t++) {
      sim.tick(1);
      if (tracker.view().settled) settledAt = sim.getSnapshot().simTime;
    }
    expect(settledAt).toBeGreaterThan(0);
    const v = tracker.view();
    for (const id of ['node-1.vm-1']) {
      const r = v.vms.get(id);
      expect(r?.impact).toBe('restarted');
      expect(r?.redirected).toBe(false);
      expect(r?.restartedOn).not.toBe('node-1');
      expect(r?.milestones.map((m) => m.stage)).toContain('ha-restarted');
      expect(r?.endT).toBe(settledAt);
    }
    const at = v.current;
    sim.tick(1000);
    expect(tracker.view().current).toBe(at);
  });

  it('host maintenance live-migrates the VMs: no interruption, the counter stays 0', () => {
    const { sim, tracker } = setup();
    act(sim, tracker, 'host.enter-maintenance', 'node-1');
    sim.tick(200);
    const v = tracker.view();
    expect(v.current).toBe(0);
    expect(v.vms.get('node-1.vm-1')?.redirected).toBe(false);
  });

  it('a VM interrupted again while the incident is open keeps it open, and the counter never drops', () => {
    const { sim, tracker } = setup();
    act(sim, tracker, 'reboot', 'node-1.cvm');
    sim.tick(80);
    act(sim, tracker, 'fail', 'node-2.vm-1');
    sim.tick(30);
    act(sim, tracker, 'recover', 'node-2.vm-1');
    sim.tick(30);
    act(sim, tracker, 'fail', 'node-2.vm-1');
    let peak = 0;
    for (let t = 0; t < 700; t++) {
      sim.tick(1);
      const now = tracker.view().current;
      expect(now).toBeGreaterThanOrEqual(peak);
      peak = now;
    }
    let v = tracker.view();
    // node-1's VMs failed back long ago; node-2.vm-1 is still down, waiting on the user.
    expect(v.settled).toBe(false);
    expect(v.waiting).toBe(true);
    expect(v.current).toBe(peak);
    expect(peak).toBeGreaterThan(4);
    act(sim, tracker, 'recover', 'node-2.vm-1');
    sim.tick(5);
    v = tracker.view();
    expect(v.settled).toBe(true);
    expect(v.current).toBe(peak);
  });

  it('a failed CVM never recovered: the counter stops once the IO resumed remotely; recovering resumes it', () => {
    const { sim, tracker } = setup();
    act(sim, tracker, 'fail', 'node-1.cvm');
    sim.tick(100);
    const stopped = tracker.view().current;
    expect(tracker.view().waiting).toBe(true);
    sim.tick(2000);
    expect(tracker.view().current).toBe(stopped);
    act(sim, tracker, 'recover', 'node-1.cvm');
    expect(tracker.view().waiting).toBe(false);
    let settled = false;
    for (let t = 0; t < 1500 && !settled; t++) {
      sim.tick(1);
      settled = tracker.view().settled;
    }
    expect(settled).toBe(true);
    const r = tracker.view().vms.get('node-1.vm-1');
    expect(r?.milestones.map((m) => m.stage)).toContain('failed-back');
    // The long wait for the failback spans a few steps after the recovery, not the time waited.
    expect(tracker.view().current - stopped).toBeGreaterThanOrEqual(2);
    expect(tracker.view().current - stopped).toBeLessThanOrEqual(6);
  });

  it('a planned controller reboot whose controller fails during it ends at the failure', () => {
    const { sim, tracker } = setup();
    act(sim, tracker, 'fa.controller.reboot', 'fa.ct1');
    sim.tick(40);
    act(sim, tracker, 'fail', 'fa.ct1');
    sim.tick(50);
    const v = tracker.view();
    expect(v.array.crashed).toBe(true);
    expect(v.array.endT).not.toBeNull();
    expect(v.settled).toBe(true);
  });
});
