/**
 * Steps view (src/domain/steps): ordering and relationships between steps, never durations.
 * Synthetic series test the derivation rules; one engine run checks the `ioChain` view field.
 */
import { describe, expect, it } from 'vitest';
import {
  countsAt,
  deriveArrayOpSteps,
  deriveVmRuns,
  deriveVmSteps,
  EventIndex,
  FIRST_STEP_TICKS,
  faultWindows,
  finishRuns,
  ioChainOf,
  isWaiting,
  nextStepTick,
  RunScanner,
  type RunSpan,
  STAGES,
  stepAt,
  stepBoundary,
  stepOfElapsed,
  type VmSample,
  vmSampleState,
  vmSeries,
} from '../../../src/domain/steps';
import type { SimEvent } from '../../../src/engine/types';
import { loadSimulation } from '../../../src/loader/simulation';

const ev = (t: number, code: string, deviceId: string): SimEvent => ({
  seq: t * 100 + code.length,
  t,
  severity: 'info',
  deviceId,
  code,
  text: code,
  causeIds: [],
  cite: [],
});
const sample = (t: number, state: string, pend: number, owner = 'n1.cvm'): VmSample => ({
  t,
  state,
  ioPendingS: pend,
  host: 'n1',
  ownerCvm: owner,
});
const run = (from: number, to: number, f: (t: number) => VmSample): VmSample[] =>
  Array.from({ length: to - from + 1 }, (_, i) => f(from + i));

describe('steps derivation', () => {
  it('a VM that never stalls has no interruption and an empty strip', () => {
    const r = deriveVmSteps(
      'v',
      [],
      run(0, 30, (t) => sample(t, 'running', 0)),
    );
    expect(r.stalledSteps).toBe(0);
    expect(r.impact).toBe('none');
    expect(r.cells).toEqual([]);
  });

  it('a one-tick pipeline artifact is not an interruption', () => {
    const r = deriveVmSteps(
      'v',
      [],
      run(0, 30, (t) => sample(t, 'running', t === 10 ? 1 : 0)),
    );
    expect(r.impact).toBe('none');
  });

  it('a stall that ends within the first step counts as one stalled step', () => {
    const events = [ev(6, 'nvme.path.lost', 'n1.cvm')];
    // The stuck IO was sent in the tick after 2; the stall runs to 10, inside the first step.
    const series = run(0, 40, (t) => sample(t, 'running', t >= 4 && t < 10 ? t - 3 : 0));
    const r = deriveVmSteps('v', events, series);
    expect(r.startT).toBe(2);
    expect(r.stalledSteps).toBe(1);
    expect(r.resumeStep).toBe(1);
    expect(r.impact).toBe('brief');
    expect(r.milestones.map((m) => m.stage)).toEqual(['stall', 'path-rerouted', 'resumed']);
  });

  it('a longer stall spans more steps, on the compressive scale', () => {
    const events = [ev(6, 'nvme.path.lost', 'n1.cvm')];
    const series = run(0, 80, (t) => sample(t, 'running', t >= 4 && t < 45 ? t - 3 : 0));
    const r = deriveVmSteps('v', events, series);
    const start = r.startT as number;
    const resumeT = r.milestones.find((m) => m.stage === 'resumed')?.t as number;
    expect(r.resumeStep).toBe(stepOfElapsed(resumeT - start));
    expect(r.resumeStep).toBeGreaterThan(2);
    expect(r.stalledSteps).toBe((r.resumeStep as number) - 1);
  });

  it('a lost path does not count as a reroute while the VM is still stalled (monotonic steps)', () => {
    // Both fabrics fail: one path is declared lost, the other follows, the VM never resumes.
    const events = [
      ev(6, 'nvme.path.lost', 'n1.cvm'),
      ev(7, 'nvme.path.lost', 'n1.cvm'),
      ev(7, 'nvme.all-paths.lost', 'n1.cvm'),
    ];
    const full = run(0, 11, (t) => sample(t, 'running', t >= 4 ? t - 3 : 0));
    let peak = 0;
    for (let n = 5; n <= full.length; n++) {
      const t = (full[n - 1] as VmSample).t;
      const seen = events.filter((e) => e.t <= t);
      const r = deriveVmSteps('v', seen, full.slice(0, n));
      const step = stepAt(r, t);
      expect(step).toBeGreaterThanOrEqual(peak);
      expect(r.milestones.some((m) => m.stage === 'path-rerouted')).toBe(false);
      peak = step;
    }
    expect(peak).toBe(1);
  });

  it('the maintenance chain keeps its order, and the long failback wait spans several steps', () => {
    const events = [
      ev(8, 'nvme.all-paths.lost', 'n1.cvm'),
      ev(20, 'hades.maintenance.enter', 'n1.cvm'),
      ev(21, 'hades.services.stopped', 'n1.cvm'),
      ev(21, 'redirector.redirect', 'n1'),
      ev(40, 'hades.maintenance.exit', 'n1.cvm'),
      ev(60, 'stargate.up', 'n1.cvm'),
      ev(90, 'redirector.failback', 'n1'),
    ];
    const series = run(0, 100, (t) =>
      t >= 3 && t < 23
        ? sample(t, 'io-stalled', t)
        : sample(t, 'running', 0, t < 3 ? 'n1.cvm' : 'n2.cvm'),
    );
    const r = deriveVmSteps('v', events, series);
    const step = (s: string) => r.milestones.find((m) => m.stage === s)?.step ?? Number.NaN;
    expect(step('stall')).toBe(1);
    // Stages that happen close together can share a step; later ones never land earlier.
    expect(step('maintenance')).toBeGreaterThanOrEqual(step('all-paths-lost'));
    expect(step('services-stopped')).toBeGreaterThanOrEqual(step('maintenance'));
    expect(step('resumed')).toBeGreaterThanOrEqual(step('redirected'));
    expect(step('maintenance-exited')).toBeGreaterThanOrEqual(step('resumed'));
    expect(step('services-restarted')).toBeGreaterThanOrEqual(step('maintenance-exited'));
    // The long wait before the sessions fail back spans several steps.
    expect(step('failed-back')).toBeGreaterThan(step('services-restarted'));
    expect(step('failed-back') - step('resumed')).toBeGreaterThanOrEqual(2);
    expect(r.impact).toBe('redirected');
    expect(r.cells.length).toBe(r.stalledSteps);
  });

  it('the step cursor follows the compressive scale and stops at the failback', () => {
    const events = [ev(6, 'nvme.path.lost', 'n1.cvm')];
    const series = run(0, 40, (t) => sample(t, 'running', t >= 4 && t < 30 ? t - 3 : 0));
    const r = deriveVmSteps('v', events, series);
    const start = r.startT as number;
    expect(stepAt(r, start - 1)).toBe(0);
    expect(stepAt(r, start)).toBe(1);
    expect(stepAt(r, start + FIRST_STEP_TICKS)).toBe(2);
    expect(stepAt(r, start + 2 * FIRST_STEP_TICKS)).toBe(3);
    expect(nextStepTick(r, start)).toBe(start + FIRST_STEP_TICKS);
    expect(nextStepTick(r, start + FIRST_STEP_TICKS)).toBe(start + 2 * FIRST_STEP_TICKS);
  });

  it('every stage has a public-safe description with a citation and a confidence label', () => {
    for (const info of Object.values(STAGES)) {
      expect(info.cite.length, info.stage).toBeGreaterThan(0);
      expect(info.text, info.stage).not.toMatch(/\b\d+\s*(s|sec|seconds|ms|minutes?)\b/i);
      expect(info.label, info.stage).not.toMatch(/\b\d+\s*(s|sec|seconds)\b/i);
    }
  });
});

describe('ioChain view field', () => {
  it('draws VM → redirector → CVM → Stargate → NIC → array port, with the path selector', () => {
    const sim = loadSimulation({ topologyId: 't1-ahv-flasharray', options: {}, seed: 1 }).sim;
    const s = sim.tick(15);
    const chain = ioChainOf(s.devices['node-1.vm-1']);
    expect(chain).not.toBeNull();
    expect(chain?.hops.map((h) => h.role)).toEqual([
      'vm',
      'redirector',
      'cvm',
      'stargate',
      'nic',
      'array-port',
    ]);
    expect(chain?.remote).toBe(false);
    expect(chain?.stalled).toBe(false);
    expect(chain?.selector).toBe('queue-depth');
    const nic = chain?.hops.find((h) => h.role === 'nic');
    expect(nic?.ids.every((id) => id.startsWith('node-1.eth'))).toBe(true);
    const port = chain?.hops.find((h) => h.role === 'array-port');
    expect(port?.ids.every((id) => id.startsWith('fa.'))).toBe(true);
  });

  it('after a redirect the chain goes through the remote CVM and the host management uplink', () => {
    const sim = loadSimulation({ topologyId: 't1-ahv-flasharray', options: {}, seed: 1 }).sim;
    sim.tick(10);
    sim.applyAction({ kind: 'fail', target: 'node-1.eth2' });
    sim.applyAction({ kind: 'fail', target: 'node-1.eth3' });
    const s = sim.tick(60);
    const chain = ioChainOf(s.devices['node-1.vm-1']);
    expect(chain?.remote).toBe(true);
    expect(chain?.hops.find((h) => h.role === 'cvm')?.ids[0]).not.toBe('node-1.cvm');
    expect(chain?.hops.find((h) => h.role === 'redirector')?.via?.length).toBeGreaterThan(0);
  });

  it('engine run, both storage NICs down: the step never goes back while the run proceeds', () => {
    const sim = loadSimulation({ topologyId: 't1-ahv-flasharray', options: {}, seed: 1 }).sim;
    const series: VmSample[] = [];
    const push = (): void => {
      const s = sim.getSnapshot();
      const f = s.devices['node-1.vm-1']?.fields ?? {};
      series.push({
        t: s.simTime,
        state: String(f.state),
        ioPendingS: typeof f.ioPendingS === 'number' ? f.ioPendingS : 0,
        host: typeof f.host === 'string' ? f.host : null,
        ownerCvm: typeof f.ownerCvm === 'string' ? f.ownerCvm : null,
      });
    };
    sim.tick(10);
    push();
    sim.applyAction({ kind: 'fail', target: 'node-1.eth2' });
    sim.applyAction({ kind: 'fail', target: 'node-1.eth3' });
    let peak = 0;
    let everRerouted = false;
    for (let i = 0; i < 90; i++) {
      sim.tick(1);
      push();
      const r = deriveVmSteps('node-1.vm-1', sim.eventLog(), series);
      const step = stepAt(r, sim.getSnapshot().simTime);
      expect(step).toBeGreaterThanOrEqual(peak);
      peak = step;
      everRerouted ||= r.milestones.some((m) => m.stage === 'path-rerouted');
    }
    expect(everRerouted).toBe(false);
    expect(peak).toBeGreaterThanOrEqual(3);
  });

  it('per-fabric: one storage NIC resumes steps before both NICs redirect through another CVM', () => {
    const resumeStep = (
      nics: readonly string[],
    ): { step: number; stages: string[]; peak: number } => {
      const sim = loadSimulation({
        topologyId: 't1-ahv-flasharray',
        options: { 'storage-vswitch-layout': 'per-fabric' },
        seed: 1,
      }).sim;
      sim.tick(30);
      const hist = [sim.getSnapshot()];
      for (const n of nics) sim.applyAction({ kind: 'fail', target: n });
      for (let i = 0; i < 120; i++) hist.push(sim.tick(1));
      const r = deriveVmSteps('node-1.vm-1', sim.eventLog(), vmSeries(hist, 'node-1.vm-1'));
      return {
        step: r.resumeStep ?? Number.POSITIVE_INFINITY,
        stages: r.milestones.map((m) => m.stage),
        peak: r.peakStuckPct,
      };
    };
    const one = resumeStep(['node-1.eth2']);
    const both = resumeStep(['node-1.eth2', 'node-1.eth3']);
    expect(one.stages).toContain('path-rerouted');
    expect(one.stages).not.toContain('maintenance');
    expect(both.stages).toEqual(
      expect.arrayContaining(['all-paths-lost', 'maintenance', 'redirected', 'resumed']),
    );
    // A NIC loss is a brief interruption (owner estimate 9–12 s); the node redirect lands several
    // steps later (about 53 s), on the compressive scale.
    expect(one.step).toBeLessThanOrEqual(2);
    expect(both.step - one.step).toBeGreaterThanOrEqual(2);
    // One NIC strands only the IO queued on its paths (a partial stall); both stall all of it.
    expect(one.peak).toBeGreaterThan(0);
    expect(one.peak).toBeLessThan(100);
    expect(both.peak).toBe(100);
  });

  it('the interruption is dated from its oldest stuck IO, not from when the stall became visible', () => {
    // IO stamped t=11 (sent during the tick after 10) is still pending at t=14 (age 3 > BLIP):
    // the run starts at 10.
    const r = deriveVmSteps(
      'v',
      [],
      run(0, 40, (t) => sample(t, 'running', t >= 12 && t < 30 ? t - 11 : 0)),
    );
    expect(r.startT).toBe(10);
  });

  it('CVM failure: stall, redirect, IO resumes; failback comes long after the CVM returns', () => {
    for (const [kind, back] of [
      ['fail', 'recover'],
      ['cvm.planned-shutdown', 'cvm.planned-start'],
    ] as const) {
      const sim = loadSimulation({
        topologyId: 't1-ahv-flasharray',
        options: { 'node-count': 3, 'vm-layout': 'two', 'storage-vswitch-layout': 'per-fabric' },
        seed: 1,
      }).sim;
      const hist = [sim.getSnapshot()];
      const run = (n: number): void => {
        for (let i = 0; i < n; i++) hist.push(sim.tick(1));
      };
      run(10);
      sim.applyAction({ kind, target: 'node-1.cvm' });
      run(100);
      const chainNow = ioChainOf(sim.getSnapshot().devices['node-1.vm-1']);
      expect(chainNow?.remote).toBe(true);
      expect(chainNow?.hops.some((h) => h.ids.includes('node-1.cvm'))).toBe(false);
      let r = deriveVmSteps('node-1.vm-1', sim.eventLog(), vmSeries(hist, 'node-1.vm-1'));
      expect(r.milestones.map((m) => m.stage)).toEqual(['stall', 'redirected', 'resumed']);
      expect(r.impact).toBe('redirected');
      sim.applyAction({ kind: back, target: 'node-1.cvm' });
      run(1500);
      r = deriveVmSteps('node-1.vm-1', sim.eventLog(), vmSeries(hist, 'node-1.vm-1'));
      expect(r.milestones.map((m) => m.stage)).toEqual([
        'stall',
        'redirected',
        'resumed',
        'services-restarted',
        'failed-back',
      ]);
      const steps = r.milestones.map((m) => m.step);
      expect(steps).toEqual([...steps].sort((x, y) => x - y));
      const at = (stage: string) => r.milestones.find((m) => m.stage === stage)?.step as number;
      expect(at('failed-back') - at('resumed')).toBeGreaterThanOrEqual(2);
    }
  });
});

/** A sample on an explicit host and CVM (HA restarts and migrations change both). */
const on = (t: number, state: string, pend: number, host: string | null, owner: string | null) => ({
  t,
  state,
  ioPendingS: pend,
  host,
  ownerCvm: owner,
});

describe('HA restart and live migration are not redirects', () => {
  it('a VM restarted by AHV HA on another host: its own outcome, the run ends when its IO resumes there', () => {
    const series = run(0, 200, (t) =>
      t < 10
        ? on(t, 'running', 0, 'n1', 'n1.cvm')
        : t < 70
          ? on(t, 'crashed', 0, null, 'n1.cvm')
          : t < 130
            ? on(t, 'restarting', 0, null, 'n1.cvm')
            : on(t, 'running', 0, 'n2', 'n2.cvm'),
    );
    const events = [ev(10, 'vm.crashed', 'v'), ev(130, 'ha.vm.restarted', 'v')];
    const r = deriveVmSteps('v', events, series);
    expect(r.impact).toBe('restarted');
    expect(r.redirected).toBe(false);
    expect(r.restartedOn).toBe('n2');
    expect(r.endT).toBe(130);
    expect(r.holds).toEqual([]);
    const stages = r.milestones.map((m) => m.stage);
    expect(stages).toEqual(['vm-down', 'ha-restarted', 'resumed']);
    expect(stages).not.toContain('redirected');
    // The counter stops at the restart (no failback to wait for).
    expect(stepAt(r, 5000)).toBe(stepAt(r, 130));
  });

  it('a live migration (owner changes with the host) is no interruption and no redirect', () => {
    const series = run(0, 60, (t) =>
      t < 20
        ? on(t, 'running', 0, 'n1', 'n1.cvm')
        : on(t, 'running', t === 20 ? 1 : 0, 'n2', 'n2.cvm'),
    );
    const r = deriveVmSteps('v', [ev(20, 'vm.migrated', 'v')], series);
    expect(r.impact).toBe('none');
    expect(r.startT).toBeNull();
  });

  it('a stall that ends with the VM on another host is not counted as a redirect either', () => {
    const series = run(0, 60, (t) =>
      t < 10
        ? on(t, 'running', 0, 'n1', 'n1.cvm')
        : t < 20
          ? on(t, 'io-stalled', t - 9, 'n1', 'n1.cvm')
          : on(t, 'running', 0, 'n2', 'n2.cvm'),
    );
    const r = deriveVmSteps('v', [], series);
    expect(r.redirected).toBe(false);
    expect(r.milestones.map((m) => m.stage)).not.toContain('redirected');
    expect(r.endT).toBe(20);
  });
});

describe('several interruptions of one VM', () => {
  it('each run of impacted samples is its own run; deriveVmSteps is the first', () => {
    const series = run(0, 100, (t) =>
      sample(t, (t >= 10 && t < 20) || (t >= 50 && t < 70) ? 'io-stalled' : 'running', 0),
    );
    const runs = deriveVmRuns('v', [], series);
    // Each is dated from the tick its stuck IO was sent (the tick before it showed).
    expect(runs.map((r) => [r.startT, r.endT])).toEqual([
      [9, 20],
      [49, 70],
    ]);
    expect(deriveVmSteps('v', [], series).startT).toBe(9);
  });

  it('the incremental scanner reads the same runs as one pass, sample by sample', () => {
    const series = run(0, 120, (t) =>
      sample(t, (t >= 10 && t < 25) || (t >= 60 && t < 90) ? 'io-stalled' : 'running', 0),
    );
    const scanner = new RunScanner();
    for (let n = 1; n <= series.length; n++) {
      const part = series.slice(0, n);
      const a = finishRuns('v', [], part, scanner.scans(part), []);
      const b = deriveVmRuns('v', [], part, []);
      expect(a).toEqual(b);
    }
  });
});

describe('runs waiting on the user (holds)', () => {
  it('the hold math: held ticks are not counted, and the next step comes that much later', () => {
    const span: RunSpan = { startT: 0, endT: null, holds: [{ from: 15, to: 45 }] };
    expect(stepAt(span, 14)).toBe(2);
    expect(stepAt(span, 40)).toBe(2);
    expect(nextStepTick(span, 16)).toBe(stepBoundary(3) + 30);
    expect(stepAt(span, stepBoundary(3) + 30)).toBe(3);
    expect(stepAt(span, stepBoundary(3) + 29)).toBe(2);
    expect(countsAt(span, 15)).toBe(true);
    expect(countsAt(span, 30)).toBe(false);
    expect(countsAt(span, 45)).toBe(true);
    const open: RunSpan = { startT: 0, endT: null, holds: [{ from: 15, to: null }] };
    expect(isWaiting(open, 20)).toBe(true);
    expect(nextStepTick(open, 16)).toBeNull();
    expect(stepAt(open, 10_000)).toBe(stepAt(open, 15));
  });

  it('a failed CVM never recovered: the IO resumed remotely, the failback cannot come, the counter stops', () => {
    const series = run(0, 400, (t) =>
      t < 5
        ? sample(t, 'running', 0)
        : t < 25
          ? sample(t, 'io-stalled', t - 4, t < 20 ? 'n1.cvm' : 'n2.cvm')
          : sample(t, 'running', 0, 'n2.cvm'),
    );
    const failed = [ev(5, 'device.failed', 'n1.cvm'), ev(20, 'redirector.redirect', 'n1')];
    const r = deriveVmSteps('v', failed, series);
    expect(r.impact).toBe('redirected');
    expect(r.endT).toBeNull();
    expect(r.holds).toEqual([{ from: 25, to: null }]);
    expect(isWaiting(r, 400)).toBe(true);
    expect(stepAt(r, 400)).toBe(stepAt(r, 25));
    expect(nextStepTick(r, 300)).toBeNull();
    // Recovered at 100: counting picks up from where it stopped, through the failback.
    const later = [
      ...failed,
      ev(100, 'device.recovered', 'n1.cvm'),
      ev(130, 'stargate.up', 'n1.cvm'),
      ev(300, 'redirector.failback', 'n1'),
    ];
    const r2 = deriveVmSteps('v', later, series);
    expect(r2.holds).toEqual([{ from: 25, to: 100 }]);
    expect(r2.endT).toBe(300);
    expect(stepAt(r2, 300)).toBe(stepOfElapsed(300 - (r2.startT as number) - 75));
    const steps = r2.milestones.map((m) => m.step);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });

  it('a CVM that reboots on its own is not a hold: the counter climbs to the failback', () => {
    const series = run(0, 400, (t) =>
      t < 5
        ? sample(t, 'running', 0)
        : t < 25
          ? sample(t, 'io-stalled', t - 4, t < 20 ? 'n1.cvm' : 'n2.cvm')
          : sample(t, 'running', 0, 'n2.cvm'),
    );
    const events = [ev(20, 'redirector.redirect', 'n1'), ev(150, 'stargate.up', 'n1.cvm')];
    const r = deriveVmSteps('v', events, series);
    expect(r.holds).toEqual([]);
    expect(isWaiting(r, 400)).toBe(false);
    expect(stepAt(r, 400)).toBeGreaterThan(stepAt(r, 150));
  });

  it('a VM failed by the user is down with nothing restarting it: held until it is recovered', () => {
    const series = run(0, 200, (t) => sample(t, t >= 10 && t < 150 ? 'failed' : 'running', 0));
    const open = deriveVmSteps('v', [], series.slice(0, 120));
    expect(open.impact).toBe('down');
    expect(open.milestones.map((m) => m.stage)).toEqual(['vm-down']);
    expect(isWaiting(open, 119)).toBe(true);
    expect(stepAt(open, 119)).toBe(1);
    const done = deriveVmSteps('v', [], series);
    expect(done.endT).toBe(150);
    expect(done.holds).toEqual([{ from: 10, to: 150 }]);
    expect(stepAt(done, 150)).toBe(1);
  });

  it('a crashed VM while the cluster has no quorum (no HA leader) is held; HA restarting it is not', () => {
    const series = run(0, 300, (t) =>
      t < 10 ? on(t, 'running', 0, 'n1', 'n1.cvm') : on(t, 'crashed', 0, null, 'n1.cvm'),
    );
    const r = deriveVmSteps('v', [ev(50, 'zk.quorum.lost', 'cluster')], series);
    expect(r.holds).toEqual([{ from: 50, to: null }]);
    expect(isWaiting(r, 299)).toBe(true);
    const ha = deriveVmSteps('v', [], series);
    expect(ha.holds).toEqual([]);
  });

  it('fault windows pair each fault with its own recovery; VMs can be ignored', () => {
    const events = [
      ev(5, 'device.failed', 'a'),
      ev(8, 'device.failed', 'vm'),
      ev(10, 'action.cvm.planned-shutdown', 'c'),
      ev(20, 'device.recovered', 'a'),
      ev(30, 'action.cvm.planned-start', 'c'),
      ev(40, 'device.failed', 'b'),
    ];
    // The failed VM is never recovered: counted, it keeps a fault in place for good.
    expect(faultWindows(events)).toEqual([{ from: 5, to: null }]);
    expect(faultWindows(new EventIndex(events), (id) => id === 'vm')).toEqual([
      { from: 5, to: 30 },
      { from: 40, to: null },
    ]);
    expect(faultWindows([ev(8, 'device.failed', 'vm')], (id) => id === 'vm')).toEqual([]);
  });

  it('a VM whose host is down keeps its own state (HA restarts it); one failed itself reads failed', () => {
    expect(vmSampleState('failed', 'running')).toBe('failed');
    expect(vmSampleState('failed', 'crashed')).toBe('crashed');
    expect(vmSampleState('failed', 'restarting')).toBe('restarting');
    expect(vmSampleState('ok', 'running')).toBe('running');
  });
});

describe('planned array operations', () => {
  it('a controller that fails during its planned reboot ends the operation there', () => {
    const events = [
      ev(10, 'fa.controller.draining', 'fa.ct1'),
      ev(20, 'fa.controller.rebooting', 'fa.ct1'),
      ev(40, 'device.failed', 'fa.ct1'),
    ];
    const op = deriveArrayOpSteps(events, 0);
    expect(op.endT).toBe(40);
    expect(op.crashed).toBe(true);
    const ok = deriveArrayOpSteps(
      [...events.slice(0, 2), ev(200, 'fa.controller.online', 'fa.ct1')],
      0,
    );
    expect(ok.endT).toBe(200);
    expect(ok.crashed).toBe(false);
  });

  it('an NDU paused for hosts waits on the user: the pause is a hold', () => {
    const events = [
      ev(0, 'fa.ndu.start', 'fa'),
      ev(0, 'fa.controller.draining', 'fa.ct1'),
      ev(100, 'fa.ndu.waiting-for-hosts', 'fa'),
      ev(300, 'fa.giveback', 'fa.ct0'),
      ev(400, 'fa.ndu.complete', 'fa'),
    ];
    const op = deriveArrayOpSteps(events, 0);
    expect(op.holds).toEqual([{ from: 100, to: 300 }]);
    expect(op.endT).toBe(400);
    const waiting = deriveArrayOpSteps(events.slice(0, 3), 0);
    expect(isWaiting(waiting, 250)).toBe(true);
  });
});
