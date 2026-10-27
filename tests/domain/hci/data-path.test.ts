import { describe, expect, it } from 'vitest';
import type { IoCompletion } from '../../../src/domain/contracts';
import { HCI_ASSUMPTIONS, MSG } from '../../../src/domain/nutanix/hci';
import type { Message } from '../../../src/engine/types';
import { harness } from './fakes';

const ACK_TIMEOUT = HCI_ASSUMPTIONS.replicaAckTimeoutS.value;

describe('write path (Bible 4g)', () => {
  it('steady state: every write is replicated RF−1 times and completes in its tick', () => {
    const h = harness('t2-hci-ahv');
    for (let t = 0; t < 10; t++) {
      const s = h.sim.tick();
      expect(h.workload.maxPendingS(s.simTime)).toBe(0);
      const repl = s.traces.filter((x) => x.kind === MSG.replicate);
      const acks = s.traces.filter((x) => x.kind === MSG.replicateAck);
      expect(repl.every((x) => x.result === 'delivered')).toBe(true);
      // 8 running VMs, one write each, RF2 → one remote copy each.
      expect(repl).toHaveLength(8);
      expect(acks).toHaveLength(8);
    }
    expect(h.workload.totals().errors).toBe(0);
    expect(h.store.underReplicated()).toBe(0);
  });

  it('a write completes only after every replica has acked', () => {
    const h = harness('t2-hci-ahv');
    h.sim.tick(5);
    // node-2's Stargate stays "up" in the cluster view but silently stops acking.
    const b2 = h.backends.get('node-2.cvm');
    if (!b2?.onMessage) throw new Error('no backend');
    const orig = b2.onMessage.bind(b2);
    const hung = new Set<string>([MSG.replicate, MSG.rebuild]);
    b2.onMessage = (m: Message, c) => (hung.has(m.kind) ? true : orig(m, c));

    const done: IoCompletion[] = [];
    const record = h.workload.record.bind(h.workload);
    h.workload.record = (c) => {
      done.push(c);
      record(c);
    };

    let s = h.sim.tick();
    expect(h.workload.maxPendingS(s.simTime)).toBe(0); // issued this tick
    s = h.sim.tick();
    expect(h.workload.maxPendingS(s.simTime)).toBeGreaterThan(0);
    const stuck = h.backends.get('node-1.cvm')?.viewFields?.()['hci.ioPending'];
    expect(stuck).toBeGreaterThan(0);
    expect(h.store.underReplicated()).toBe(0); // nothing committed elsewhere yet

    h.sim.tick(ACK_TIMEOUT + 1);
    // Re-placed on another node: completed, and the group is under-replicated until rebuilt.
    const slow = done.filter(
      (c) => c.req.op === 'write' && c.completedAt - c.req.issuedAt >= ACK_TIMEOUT,
    );
    expect(slow.length).toBeGreaterThan(0);
    expect(slow.every((c) => c.outcome.status === 'ok')).toBe(true);
    expect(h.store.underReplicated()).toBeGreaterThan(0);
    const filling = h.store
      .extentGroups()
      .filter((eg) => eg.replicas.some((r) => r.state === 'filling'));
    expect(filling.length).toBeGreaterThan(0);
    for (const eg of filling) {
      expect(eg.replicas.find((r) => r.node === 'node-2.cvm')?.state).toBe('behind');
    }
  });

  it('writes redirected to a non-local Stargate write every copy remotely; RF is still met', () => {
    const h = harness('t2-hci-ahv');
    h.sim.tick(5);
    h.sim.applyAction({ kind: 'fail', target: 'node-1.cvm' });
    h.sim.tick(20);
    const vm = h.workload.vms.find((v) => v.vm === 'node-1.vm-1');
    expect(vm?.servedBy).toEqual(['node-1.cvm', 'node-2.cvm']);
    const before = vm?.writes ?? 0;
    h.sim.tick(5);
    expect(vm?.writes).toBeGreaterThan(before);
    expect(vm?.errors).toEqual([]);

    for (const eg of h.store.extentGroups().filter((e) => e.vdisk === vm?.vdisk)) {
      // The copies being written; node-1's own copy fell behind (catches up when it returns).
      const current = eg.replicas.filter((r) => r.state === 'ok' || r.state === 'filling');
      expect(current.map((r) => r.node)).not.toContain('node-1.cvm');
      expect(eg.replicas.find((r) => r.node === 'node-1.cvm')?.state).toBe('behind');
      expect(new Set(current.map((r) => r.node)).size).toBe(current.length);
      expect(current.length).toBe(2);
    }
  });
});

describe('read path', () => {
  it('reads are local while the local replica is live, remote otherwise', () => {
    const h = harness('t2-hci-ahv');
    for (let i = 0; i < 5; i++) {
      const s = h.sim.tick();
      expect(s.traces.filter((x) => x.kind === MSG.read)).toHaveLength(0);
    }
    h.sim.applyAction({ kind: 'fail', target: 'node-1.cvm' });
    h.sim.tick(3);
    let remote = 0;
    for (let i = 0; i < 8; i++) {
      remote += h.sim.tick().traces.filter((x) => x.kind === MSG.read).length;
    }
    expect(remote).toBeGreaterThan(0);
    expect(h.workload.totals().errors).toBe(0);
  });

  it('pathsFor lists the remote replica endpoints a vDisk used last tick', () => {
    const h = harness('t2-hci-ahv');
    h.sim.tick(3);
    const paths = h.backends.get('node-1.cvm')?.pathsFor?.('node-1.vm-1.vdisk-1') ?? [];
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p.endsWith('.cvm.mgmt') && !p.startsWith('node-1.'))).toBe(true);
  });
});

describe('health()', () => {
  it('ok when fully replicated, degraded when under-replicated, unavailable without metadata', () => {
    const h = harness('t2-hci-ahv');
    h.sim.tick(3);
    const b = h.backends.get('node-1.cvm');
    expect(b?.health()).toBe('ok');
    h.sim.applyAction({ kind: 'fail', target: 'node-4' });
    h.sim.tick(3);
    expect(b?.health()).toBe('degraded');
    h.cluster.metadataOverride = false;
    expect(b?.health()).toBe('unavailable');
    // IO hangs while metadata is unavailable.
    const t = h.sim.tick(5).simTime;
    expect(h.workload.maxPendingS(t)).toBeGreaterThanOrEqual(4);
    h.cluster.metadataOverride = undefined;
    const t2 = h.sim.tick(2).simTime;
    expect(h.workload.maxPendingS(t2)).toBe(0);
  });
});

describe('capacity (Bible 4i)', () => {
  it('warns above the resilient-capacity threshold and goes read-only at the read-only threshold', () => {
    const h = harness('t2-hci-ahv');
    h.sim.tick(2);
    h.sim.applyAction({ kind: 'hci.set-capacity', target: 'node-1.cvm', params: { usedPct: 70 } });
    h.sim.tick();
    expect(h.events('hci.capacity.warn')).toHaveLength(1);
    expect(h.derived()['hci.readOnly']).toBe(false);

    h.sim.applyAction({
      kind: 'hci.set-capacity',
      target: 'node-1.disk-1',
      params: { usedPct: 95 },
    });
    h.sim.tick(3);
    expect(h.events('hci.capacity.read-only')).toHaveLength(1);
    expect(h.derived()['hci.readOnly']).toBe(true);
    const { reads } = h.workload.totals();
    const errs = h.workload.vms.flatMap((v) => v.errors);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toMatch(/read-only/);
    h.sim.tick(2);
    expect(h.workload.totals().reads).toBeGreaterThan(reads);

    h.sim.applyAction({ kind: 'hci.set-capacity', target: 'node-1.cvm', params: { usedPct: 20 } });
    h.sim.tick();
    expect(h.events('hci.capacity.ok')).toHaveLength(1);
  });
});
