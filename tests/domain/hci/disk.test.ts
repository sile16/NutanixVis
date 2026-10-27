import { describe, expect, it } from 'vitest';
import { current } from '../../../src/domain/versions/profiles/current';
import { harness } from './fakes';

const T0 = 10;
const DISK = 'node-1.disk-3';
const LIMIT = current.hci.diskOfflineEventsPerHourToStayOffline.value;
const SMART = current.hci.diskSmartCheckS.value;

describe('disk failure (Bible 4i)', () => {
  it('single disk failure: offline, immediate rebuild, no IO impact, back to OK', () => {
    const h = harness('t2-hci-ahv');
    h.sim.tick(T0);
    const replicas = h.store.replicasOnDisk(DISK);
    expect(replicas).toBeGreaterThan(0);
    h.sim.applyAction({ kind: 'disk.fail', target: DISK });
    const s = h.sim.tick();

    expect(h.disk(DISK).state).toBe('offline');
    const off = h.events('disk.offline');
    expect(off.map((e) => e.deviceId)).toEqual([DISK]);
    expect(off[0]?.confidence).toBe('verified');
    const start = h.events('curator.rebuild.start');
    expect(start).toHaveLength(1);
    expect(start[0]?.t).toBe(s.simTime);
    expect(start[0]?.deviceId).toBe('node-1.cvm');
    expect(start[0]?.causeIds).toEqual([`e${off[0]?.seq}`]);
    expect(h.sim.causalChain(`e${start[0]?.seq}`).map((e) => e.code)).toContain('disk.offline');
    expect(s.derived.resiliency).toBe('Rebuilding');

    const END = T0 + 1200;
    let sawRebuilding = false;
    while (h.sim.getSnapshot().simTime < END) {
      const x = h.sim.tick();
      expect(x.derived.dataAvailable).toBe(true);
      expect(h.workload.maxPendingS(x.simTime)).toBeLessThanOrEqual(1);
      sawRebuilding ||= x.derived.resiliency === 'Rebuilding';
    }
    expect(sawRebuilding).toBe(true);
    expect(h.derived().resiliency).toBe('OK');
    expect(h.disk(DISK).state).not.toBe('online');
    expect(h.workload.totals().errors).toBe(0);
    // No HA, no redirect: the disk's own node keeps serving its VMs.
    for (const v of h.workload.vms) expect(v.servedBy).toEqual([v.home]);
  });

  it('a host failure does not mark its disks offline (the node is down, not the disk)', () => {
    const h = harness('t2-hci-ahv');
    h.sim.tick(T0);
    h.sim.applyAction({ kind: 'fail', target: 'node-2' });
    h.sim.tick(2);
    expect(h.events('disk.offline')).toHaveLength(0);
    expect(h.disk('node-2.disk-1').state).toBe('online');
    expect(h.sim.getSnapshot().devices['node-2.disk-1']?.status).not.toBe('healthy');
  });

  it('after the fault clears, Hades runs a SMART check and returns the disk to service', () => {
    const h = harness('t2-hci-ahv');
    h.sim.tick(T0);
    h.sim.applyAction({ kind: 'disk.fail', target: DISK });
    h.sim.tick(30);
    const under = Number(h.derived().underReplicated);
    expect(under).toBeGreaterThan(0);
    h.sim.applyAction({ kind: 'recover', target: DISK });
    h.sim.tick();
    expect(h.disk(DISK).state).toBe('smart-check');
    expect(h.events('disk.smart-check')).toHaveLength(1);
    h.sim.tick(SMART);
    expect(h.disk(DISK).state).toBe('online');
    expect(h.events('disk.online')).toHaveLength(1);
    // Its copies catch up and the rebuild is no longer needed for them.
    h.sim.tick(3);
    expect(Number(h.derived().underReplicated)).toBeLessThan(under);
  });

  it(`a disk offline ${LIMIT} times within an hour stays offline (flapping)`, () => {
    const h = harness('t2-hci-ahv');
    h.sim.tick(T0);
    const cycle = 60;
    const at = (t: number) => {
      while (h.sim.getSnapshot().simTime < t) h.sim.tick();
    };
    for (let i = 0; i < LIMIT; i++) {
      at(T0 + i * 2 * cycle);
      h.sim.applyAction({ kind: 'disk.fail', target: DISK });
      at(T0 + i * 2 * cycle + cycle);
      h.sim.applyAction({ kind: 'recover', target: DISK });
      if (i === 0) {
        at(T0 + 2 * cycle - 1);
        expect(h.disk(DISK).state).toBe('online');
      }
    }
    at(T0 + (LIMIT - 1) * 2 * cycle + cycle + 300);
    expect(h.disk(DISK).state).toBe('failed');
    expect(h.disk(DISK).offlineEventsLastHour).toBe(LIMIT);
    expect(h.events('disk.offline')).toHaveLength(LIMIT);
    expect(h.events('disk.kept-offline')).toHaveLength(1);
    expect(h.events('disk.kept-offline')[0]?.cite).toEqual(
      current.hci.diskOfflineEventsPerHourToStayOffline.cite,
    );
    expect(h.workload.totals().errors).toBe(0);
    expect(h.derived().dataAvailable).toBe(true);
  });

  it('offline events older than an hour do not count', () => {
    const h = harness('t2-hci-ahv');
    h.sim.tick(T0);
    for (let i = 0; i < LIMIT - 1; i++) {
      h.sim.applyAction({ kind: 'disk.fail', target: DISK });
      h.sim.tick(5);
      h.sim.applyAction({ kind: 'recover', target: DISK });
      h.sim.tick(SMART + 2);
    }
    h.sim.tick(current.hci.diskOfflineWindowS.value);
    expect(h.disk(DISK).offlineEventsLastHour).toBe(0);
    h.sim.applyAction({ kind: 'disk.fail', target: DISK });
    h.sim.tick(5);
    h.sim.applyAction({ kind: 'recover', target: DISK });
    h.sim.tick(SMART + 2);
    expect(h.disk(DISK).state).toBe('online');
  });

  it('disk.recover on a disk kept offline models an operator re-adding it', () => {
    const h = harness('t2-hci-ahv');
    h.sim.tick(T0);
    for (let i = 0; i < LIMIT; i++) {
      h.sim.applyAction({ kind: 'disk.fail', target: DISK });
      h.sim.tick(2);
      h.sim.applyAction({ kind: 'disk.recover', target: DISK });
      h.sim.tick(SMART + 2);
    }
    expect(h.disk(DISK).state).toBe('failed');
    expect(h.sim.availableActions(DISK).map((a) => a.kind)).toContain('disk.recover');
    h.sim.applyAction({ kind: 'disk.recover', target: DISK });
    h.sim.tick();
    expect(h.disk(DISK).state).toBe('online');
    expect(h.disk(DISK).offlineEventsLastHour).toBe(0);
    expect(h.store.replicasOnDisk(DISK)).toBe(0);
  });

  it('offers disk actions only where they apply', () => {
    const h = harness('t2-hci-ahv');
    h.sim.tick();
    const kinds = (id: string) => h.sim.availableActions(id).map((a) => a.kind);
    expect(kinds(DISK)).toContain('disk.fail');
    expect(kinds(DISK)).not.toContain('disk.recover');
    expect(kinds('node-1.cvm')).not.toContain('disk.fail');
    expect(kinds('node-1.cvm')).toContain('hci.set-capacity');
    h.sim.applyAction({ kind: 'disk.fail', target: DISK });
    h.sim.tick();
    expect(kinds(DISK)).toContain('disk.recover');
    expect(kinds(DISK)).not.toContain('disk.fail');
  });
});
