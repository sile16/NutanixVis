/**
 * Steps view (src/domain/steps): ordering and relationships between steps, never durations.
 * Synthetic series test the derivation rules; one engine run checks the `ioChain` view field.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveVmSteps,
  ioChainOf,
  nextStepTick,
  STAGES,
  stepAt,
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

  it('partial path loss: stall then retry on another path is two steps', () => {
    const events = [ev(6, 'nvme.path.lost', 'n1.cvm')];
    const series = run(0, 40, (t) => sample(t, 'running', t >= 4 && t < 30 ? t - 3 : 0));
    const r = deriveVmSteps('v', events, series);
    expect(r.stalledSteps).toBe(2);
    expect(r.resumeStep).toBe(2);
    expect(r.impact).toBe('brief');
    expect(r.milestones.map((m) => [m.stage, m.step])).toEqual([
      ['stall', 1],
      ['path-rerouted', 2],
      ['resumed', 2],
    ]);
  });

  it('a lost path does not count as a reroute while the VM is still stalled (monotonic steps)', () => {
    // Both fabrics fail: one path is declared lost, the other follows, the VM never resumes.
    const events = [
      ev(6, 'nvme.path.lost', 'n1.cvm'),
      ev(7, 'nvme.path.lost', 'n1.cvm'),
      ev(7, 'nvme.all-paths.lost', 'n1.cvm'),
    ];
    const full = run(0, 12, (t) => sample(t, 'running', t >= 4 ? t - 3 : 0));
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

  it('every stage of the maintenance chain is a later step than the one before', () => {
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
    expect(step('maintenance')).toBeGreaterThan(step('all-paths-lost'));
    expect(step('services-stopped')).toBeGreaterThan(step('maintenance'));
    expect(step('resumed')).toBeGreaterThan(step('redirected'));
    expect(step('maintenance-exited')).toBeGreaterThan(step('resumed'));
    expect(step('services-restarted')).toBeGreaterThan(step('maintenance-exited'));
    expect(step('failed-back')).toBeGreaterThan(step('services-restarted'));
    expect(r.impact).toBe('redirected');
    expect(r.cells.length).toBe(r.stalledSteps);
  });

  it('step cursor and the next-step target follow milestone order', () => {
    const events = [ev(6, 'nvme.path.lost', 'n1.cvm')];
    const series = run(0, 40, (t) => sample(t, 'running', t >= 4 && t < 30 ? t - 3 : 0));
    const r = deriveVmSteps('v', events, series);
    expect(stepAt(r, 1)).toBe(0);
    expect(stepAt(r, 6)).toBe(2);
    expect(nextStepTick(r, 1)).toBe(r.milestones[0]?.t);
    expect(nextStepTick(r, 100)).toBeNull();
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

  it('CVM failure: stall (1), redirect (2), IO resumes (3); failback comes after the CVM returns', () => {
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
      expect(r.milestones.map((m) => [m.stage, m.step])).toEqual([
        ['stall', 1],
        ['redirected', 2],
        ['resumed', 3],
      ]);
      expect(r.impact).toBe('redirected');
      sim.applyAction({ kind: back, target: 'node-1.cvm' });
      run(1500);
      r = deriveVmSteps('node-1.vm-1', sim.eventLog(), vmSeries(hist, 'node-1.vm-1'));
      expect(r.milestones.map((m) => [m.stage, m.step])).toEqual([
        ['stall', 1],
        ['redirected', 2],
        ['resumed', 3],
        ['services-restarted', 4],
        ['failed-back', 5],
      ]);
    }
  });
});
