import { describe, expect, it } from 'vitest';
import { MSG } from '../../../src/domain/nutanix/hci';
import { current } from '../../../src/domain/versions/profiles/current';
import type { Snapshot } from '../../../src/engine/types';
import { type Harness, harness } from './fakes';

const T0 = 10;
const RATE = current.hci.rebuildGiBpsPerNode.value;
/** A powered-off node is declared down when its ZK session expires; rebuild starts after that. */
const DETECT = current.hci.stargateDownDetectS.value;
const DELAY = current.hci.rebuildStartDelayS.value;
const STARTS_AFTER = DETECT + DELAY;

/** Tick until `pred` holds (or `max` ticks); returns the snapshot where it first held. */
function until(h: Harness, pred: (s: Snapshot) => boolean, max = 10_000): Snapshot {
  for (let i = 0; i < max; i++) {
    const s = h.sim.tick();
    if (pred(s)) return s;
  }
  throw new Error(`condition not reached within ${max} ticks`);
}

const d = (s: Snapshot) => s.derived;

describe('Curator rebuild (Bible 4i)', () => {
  it('starts once the node is declared down plus the start delay, then runs at the modeled rate', () => {
    const h = harness('t2-hci-ahv');
    h.sim.tick(T0);
    const lostGiB = h.store.replicasOn('node-4.cvm') * h.store.replicaGiB();
    h.sim.applyAction({ kind: 'fail', target: 'node-4' });
    const s1 = h.sim.tick();
    // Under-replicated at once, but Curator waits for detection and the start delay.
    expect(d(s1).resiliency).toBe('Rebuilding');
    h.sim.tick(STARTS_AFTER - 1);
    expect(h.events('curator.rebuild.start')).toHaveLength(0);
    h.sim.tick();

    const start = h.events('curator.rebuild.start');
    expect(start).toHaveLength(1);
    expect(start[0]?.t).toBe(s1.simTime + STARTS_AFTER);
    expect(start[0]?.deviceId).toBe('node-4.cvm');
    expect(start[0]?.cite).toContain('ntnx-bible-4i');
    expect(d(s1).dataAvailable).toBe(true);

    let prev = Number(d(s1)['hci.rebuildRemainingGiB']);
    let sawTraffic = false;
    const done = until(h, (s) => {
      const rem = Number(d(s)['hci.rebuildRemainingGiB']);
      expect(rem).toBeLessThanOrEqual(prev + 1);
      prev = rem;
      expect(d(s).dataAvailable).toBe(true);
      sawTraffic ||= s.traces.some((t) => t.kind === MSG.rebuild && t.result === 'delivered');
      return d(s).resiliency === 'OK';
    });
    expect(sawTraffic).toBe(true);
    expect(d(done).underReplicated).toBe(0);
    expect(h.events('curator.rebuild.complete')).toHaveLength(1);
    // Spread across the 3 survivors: ~lost / (rate × 3) after the start, plus a tick of probing.
    const expected = STARTS_AFTER + lostGiB / (RATE * 3);
    const took = done.simTime - s1.simTime;
    expect(took).toBeGreaterThan(expected * 0.95);
    expect(took).toBeLessThan(expected * 1.1 + 5);
    expect(h.workload.totals().errors).toBe(0);
  });

  it('a larger cluster rebuilds the same node faster (work spread over N survivors)', () => {
    const time = (n: number) => {
      const h = harness('t2-hci-ahv', { 'node-count': n });
      h.sim.tick(T0);
      h.sim.applyAction({ kind: 'fail', target: 'node-1' });
      const s1 = h.sim.tick();
      return until(h, (s) => d(s).resiliency === 'OK').simTime - s1.simTime;
    };
    expect(time(8)).toBeLessThan(time(4));
  });

  it('a Stargate-only failure also starts the rebuild, attributed to that CVM', () => {
    const h = harness('t2-hci-ahv');
    h.sim.tick(T0);
    h.cluster.stargateStopped.add('node-2.cvm');
    // A clean Stargate stop closes its ZK session, so detection is fast.
    h.sim.tick(current.hci.stargateStopDetectS.value + DELAY + 1);
    expect(h.events('curator.rebuild.start').map((e) => e.deviceId)).toEqual(['node-2.cvm']);
  });

  it('a node returning mid-rebuild makes its untouched replicas live again', () => {
    const h = harness('t2-hci-ahv');
    h.sim.tick(T0);
    h.sim.applyAction({ kind: 'fail', target: 'node-4' });
    h.sim.tick(STARTS_AFTER + 60);
    const before = Number(d(h.sim.getSnapshot()).underReplicated);
    h.sim.applyAction({ kind: 'recover', target: 'node-4' });
    const s = h.sim.tick();
    expect(Number(d(s).underReplicated)).toBeLessThan(before);
    until(h, (x) => d(x).resiliency === 'OK');
  });

  it('extra copies left by a returning node are removed at the next Curator partial scan', () => {
    const h = harness('t2-hci-ahv');
    h.sim.tick(T0);
    h.sim.applyAction({ kind: 'fail', target: 'node-4' });
    until(h, (s) => d(s).resiliency === 'OK');
    h.sim.applyAction({ kind: 'recover', target: 'node-4' });
    const back = h.sim.tick();
    expect(Number(d(back)['hci.garbageReplicas'])).toBeGreaterThan(0);
    const scan = current.hci.curatorPartialScanS.value;
    const s = until(h, (x) => x.simTime % scan === 0);
    expect(Number(d(s)['hci.garbageReplicas'])).toBe(0);
    // (A scan that fell inside the long rebuild may already have removed earlier stale copies.)
    expect(h.events('curator.cleanup').filter((e) => e.t > back.simTime)).toHaveLength(1);
    expect(d(s).resiliency).toBe('OK');
  });
});

describe('T2 scenario shapes', () => {
  it('FT1: a second node failure after the rebuild (and ring detach) is survived', () => {
    const h = harness('t2-hci-ahv');
    h.sim.tick(T0);
    h.sim.applyAction({ kind: 'fail', target: 'node-4' });
    h.sim.tick();
    const rebuilt = until(h, (s) => d(s).resiliency === 'OK');
    const secondAt =
      Math.max(rebuilt.simTime, T0 + current.cluster.cassandraRingDetachS.value) + 600;
    until(h, (s) => s.simTime >= secondAt);
    expect(h.cluster.metadataAvailable()).toBe(true);
    h.sim.applyAction({ kind: 'fail', target: 'node-3' });
    const s = h.sim.tick();
    expect(d(s).dataAvailable).toBe(true);
    expect(d(s).resiliency).toBe('Rebuilding');
    until(h, (x) => {
      expect(d(x).dataAvailable).toBe(true);
      return d(x).resiliency === 'OK';
    });
    expect(h.workload.maxPendingS(h.sim.getSnapshot().simTime)).toBe(0);
  });

  it('FT1: a second node failure during the rebuild makes data unavailable until a node returns', () => {
    const h = harness('t2-hci-ahv');
    h.sim.tick(T0);
    h.sim.applyAction({ kind: 'fail', target: 'node-4' });
    h.sim.tick(STARTS_AFTER + 30);
    const mid = h.sim.getSnapshot();
    expect(d(mid).resiliency).toBe('Rebuilding');
    expect(Number(d(mid).underReplicated)).toBeGreaterThan(0);

    h.sim.applyAction({ kind: 'fail', target: 'node-3' });
    const s = h.sim.tick();
    expect(d(s).dataAvailable).toBe(false);
    expect(d(s).resiliency).toBe('Critical');
    const ev = h.events('hci.data.unavailable');
    expect(ev).toHaveLength(1);
    expect(ev[0]?.confidence).toBe('unverified');

    const hung = h.sim.tick(600);
    expect(h.workload.maxPendingS(hung.simTime)).toBeGreaterThan(500);

    h.sim.applyAction({ kind: 'recover', target: 'node-4' });
    const back = h.sim.tick();
    expect(d(back).dataAvailable).toBe(true);
    expect(h.events('hci.data.available')).toHaveLength(1);
    h.sim.tick(5);
    expect(h.workload.maxPendingS(h.sim.getSnapshot().simTime)).toBeLessThan(5);
  });

  it('FT2 (RF3, 5 nodes): two concurrent node failures keep data available and rebuild', () => {
    const h = harness('t2-hci-ahv', { 'replication-factor': 3, 'node-count': 5 });
    h.sim.tick(T0);
    expect(d(h.sim.getSnapshot())['hci.dataNodeFailureTolerance']).toBe(2);
    h.sim.applyAction({ kind: 'fail', target: 'node-1' });
    h.sim.applyAction({ kind: 'fail', target: 'node-2' });
    const s = h.sim.tick();
    expect(d(s).dataAvailable).toBe(true);
    expect(d(s).resiliency).toBe('Rebuilding');
    expect(d(s)['hci.dataNodeFailureTolerance']).toBe(0);
    h.sim.tick(STARTS_AFTER);
    expect(h.events('curator.rebuild.start').map((e) => e.deviceId)).toEqual([
      'node-1.cvm',
      'node-2.cvm',
    ]);
    until(h, (x) => {
      expect(d(x).dataAvailable).toBe(true);
      return d(x).resiliency === 'OK';
    });
    for (const eg of h.store.extentGroups()) {
      expect(h.store.liveReplicas(eg)).toHaveLength(3);
    }
    expect(h.workload.totals().errors).toBe(0);
  });

  it('resiliency is Critical when too few nodes remain to restore RF', () => {
    const h = harness('t2-hci-ahv', { 'replication-factor': 3, 'node-count': 5 });
    h.sim.tick(T0);
    h.cluster.metadataOverride = true; // isolate the data rule from the fake's metadata quorum
    h.sim.applyAction({ kind: 'fail', target: 'node-1' });
    h.sim.applyAction({ kind: 'fail', target: 'node-2' });
    h.sim.tick(5);
    h.sim.applyAction({ kind: 'fail', target: 'node-3' });
    const s = h.sim.tick(3);
    expect(d(s).resiliency).toBe('Critical');
    h.sim.tick(600);
    expect(d(h.sim.getSnapshot()).resiliency).toBe('Critical');
    expect(Number(d(h.sim.getSnapshot()).underReplicated)).toBeGreaterThan(0);
  });

  it('block awareness met: a whole block failing leaves data available', () => {
    const h = harness('t2-hci-ahv', { 'node-count': 6, 'block-layout': 'three-blocks' });
    h.sim.tick(T0);
    expect(d(h.sim.getSnapshot()).blockAwareness).toBe('met');
    h.sim.applyAction({ kind: 'fail', target: 'node-1' });
    h.sim.applyAction({ kind: 'fail', target: 'node-4' });
    for (let i = 0; i < 30; i++) expect(d(h.sim.tick()).dataAvailable).toBe(true);
    until(h, (x) => d(x).resiliency === 'OK');
  });

  it('block awareness not met: a whole block failing makes data unavailable until it returns', () => {
    const h = harness('t2-hci-ahv', { 'node-count': 4, 'block-layout': 'three-blocks' });
    h.sim.tick(T0);
    expect(d(h.sim.getSnapshot()).blockAwareness).toBe('not-met');
    h.sim.applyAction({ kind: 'fail', target: 'node-1' });
    h.sim.applyAction({ kind: 'fail', target: 'node-4' });
    expect(d(h.sim.tick()).dataAvailable).toBe(false);
    h.sim.tick(300);
    h.sim.applyAction({ kind: 'recover', target: 'node-1' });
    h.sim.applyAction({ kind: 'recover', target: 'node-4' });
    expect(d(h.sim.tick()).dataAvailable).toBe(true);
  });

  it('is deterministic', () => {
    const run = () => {
      const h = harness('t2-hci-ahv');
      h.sim.tick(T0);
      h.sim.applyAction({ kind: 'fail', target: 'node-2' });
      h.sim.tick(100);
      h.sim.applyAction({ kind: 'disk.fail', target: 'node-3.disk-1' });
      h.sim.tick(100);
      return [
        h.sim.eventLog().map((e) => `${e.t} ${e.code}@${e.deviceId}`),
        d(h.sim.getSnapshot()),
      ];
    };
    expect(run()).toEqual(run());
  });
});
