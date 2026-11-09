/**
 * Steps view (src/domain/steps): ordering and relationships between steps, never durations.
 * Synthetic series test the derivation rules; one engine run checks the `ioChain` view field.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveVmSteps,
  FIRST_STEP_TICKS,
  ioChainOf,
  nextStepTick,
  STAGES,
  stepAt,
  stepOfElapsed,
  type VmSample,
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
