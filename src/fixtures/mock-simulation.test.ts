import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from './catalog';
import { createMockSimulation } from './mock-simulation';
import { t1Frames } from './snapshots/t1-frames';

const t1 = () =>
  createMockSimulation({
    frames: [
      { snapshot: t1Frames.steady, holdTicks: 2 },
      { snapshot: t1Frames.swAFailing, holdTicks: 1 },
      { snapshot: t1Frames.fabricB, holdTicks: 2 },
    ],
  });

describe('mock simulation', () => {
  it('returns a stable, frozen snapshot between ticks and notifies subscribers', () => {
    const sim = t1();
    const s0 = sim.getSnapshot();
    expect(sim.getSnapshot()).toBe(s0);
    expect(Object.isFrozen(s0)).toBe(true);
    expect(Object.isFrozen(s0.devices['sw-a'])).toBe(true);
    let calls = 0;
    const off = sim.subscribe(() => {
      calls += 1;
    });
    const s1 = sim.tick();
    expect(s1).not.toBe(s0);
    expect(s1.simTime).toBe(s0.simTime + 1);
    expect(s1.version).toBeGreaterThan(s0.version);
    off();
    sim.tick();
    expect(calls).toBe(1);
  });

  it('cycles through the frames, including a failed switch with dropped traces', () => {
    const sim = t1();
    sim.tick(2);
    const failing = sim.getSnapshot();
    expect(failing.devices['sw-a']?.status).toBe('failed');
    expect(failing.traces.some((t) => t.result === 'dropped')).toBe(true);
    expect(failing.events.map((e) => e.code)).toContain('switch.failed');
    sim.tick(3);
    expect(sim.getSnapshot().devices['sw-a']?.status).toBe('healthy');
    expect(sim.eventLog().some((e) => e.code === 'fixture.loop')).toBe(true);
  });

  it('renumbers frame events and keeps their causal chain', () => {
    const sim = t1();
    sim.tick(3);
    const log = sim.eventLog();
    const seqs = log.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    const lost = log.find((e) => e.code === 'nvme.path.lost');
    expect(lost?.causeIds).toEqual([`e${log[log.length - 6]?.seq}`]);
    const redistributed = log.find((e) => e.code === 'nvme.io.redistributed');
    expect(redistributed?.causeIds).toEqual([`e${lost?.seq}`]);
  });

  it('fast-forwards to the next frame boundary', () => {
    const sim = t1();
    expect(sim.getSnapshot().nextTimerAt).toBe(2);
    expect(sim.runUntilNextTimer().simTime).toBe(2);
  });

  it('applies queued actions at the start of the next tick, only applicable ones are offered', () => {
    const sim = t1();
    const kinds = (id: string) => sim.availableActions(id).map((a) => a.kind);
    expect(kinds('sw-b')).toEqual(['fail']);
    expect(kinds('l-isl')).toEqual(['link-down']);
    expect(kinds('node-1.vs1')).toContain('vswitch.set-bond-mode');
    expect(kinds('fa.ct0')).toContain('fa.controller.failover');
    expect(kinds('nope')).toEqual([]);

    sim.applyAction({ kind: 'fail', target: 'sw-b' });
    expect(sim.getSnapshot().devices['sw-b']?.status).toBe('healthy');
    const s = sim.tick();
    expect(s.devices['sw-b']?.status).toBe('failed');
    expect(s.links['l-n1-eth3']?.status).toBe('down');
    expect(
      s.traces.filter((t) => t.links.includes('l-n1-eth3')).every((t) => t.result === 'dropped'),
    ).toBe(true);
    expect(kinds('sw-b')).toEqual(['recover']);

    sim.applyAction({
      kind: 'vswitch.set-bond-mode',
      target: 'node-1.vs1',
      params: { mode: 'balance-tcp' },
    });
    const s2 = sim.tick();
    expect(s2.devices['node-3.vs1']?.fields.bondMode).toBe('balance-tcp');
    expect(s2.devices['node-3.vs0']?.fields.bondMode).toBe('active-backup');
  });

  it('every catalog entry builds a simulation whose snapshot carries the selected versions', () => {
    for (const entry of fixtureCatalog) {
      const sim = entry.createSimulation({ nutanix: 'aos-7.6', profileId: 'current' });
      expect(sim.getSnapshot().topologyId).toBe(entry.id);
      expect(sim.getSnapshot().versions.nutanix).toBe('aos-7.6');
    }
  });
});
