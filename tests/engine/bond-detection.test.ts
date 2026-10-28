/**
 * Bond behavior added from the AHV network research (SPEC §5.3 "Failure detection in bonds"):
 * the pinned active-backup member, hung switches that only carrier loss can clear, LACP
 * fallback-ab, and the OVS rebalance preconditions.
 */
import { describe, expect, it } from 'vitest';
import type { EngineTrace, NetworkSpec } from '../../src/engine';
import {
  codes,
  type FabricOptions,
  fabric,
  type Probe,
  probeSim,
  traceOf,
  traces,
} from './helpers';

const H1 = 'h1.cvm.ep10';
const H2 = 'h2.cvm.ep10';

const dropped = (ts: readonly EngineTrace[]) => ts.filter((t) => t.result === 'dropped');
const flows = (src: string, dst: string, n: number): Probe[] =>
  Array.from({ length: n }, (_, i) => ({ src, dst, srcPort: 40000 + i }));

/** `fabric()` with h2's bond starting on its Switch B member (`set-active-slave h2.eth1`). */
function alternate(o: FabricOptions = {}): NetworkSpec {
  const net = fabric(o);
  return {
    ...net,
    bonds: (net.bonds ?? []).map((b) =>
      b.id === 'h2.vs1' ? { ...b, initialActive: 'h2.eth1' } : b,
    ),
  };
}

describe('active-backup starting member (bond/set-active-slave)', () => {
  it('starts on the pinned member, fails over on carrier loss and does not fail back', () => {
    const s = probeSim(alternate(), [{ src: H2, dst: 'tgt.ep1' }]);
    let snap = s.tick();
    expect(snap.devices['h1.vs1']?.fields).toMatchObject({ activeMember: 'h1.eth0' });
    expect(snap.devices['h2.vs1']?.fields).toMatchObject({
      activeMember: 'h2.eth1',
      initialActive: 'h2.eth1',
    });
    expect(traceOf(snap, H2, 'tgt.ep1').egress).toBe('h2.eth1');
    s.applyAction({ kind: 'link-down', target: 'l-h2-eth1' });
    snap = s.tick();
    expect(snap.devices['h2.vs1']?.fields.activeMember).toBe('h2.eth0');
    s.applyAction({ kind: 'link-up', target: 'l-h2-eth1' });
    snap = s.tick();
    expect(snap.devices['h2.vs1']?.fields.activeMember).toBe('h2.eth0');
  });

  it('rejects a starting member that is not cabled to the bond', () => {
    const net = fabric();
    const bad = {
      ...net,
      bonds: (net.bonds ?? []).map((b) => ({ ...b, initialActive: 'tgt.p0' })),
    };
    expect(() => probeSim(bad, [])).toThrow(/initial active/);
  });
});

describe('hung switch: carrier-only bond modes never detect it', () => {
  for (const mode of ['active-backup', 'balance-slb', 'no-bond'] as const) {
    it(`${mode}: blackholed with no timer until the switch is powered off`, () => {
      const s = probeSim(fabric({ mode }), [{ src: H1, dst: 'tgt.ep1' }]);
      expect(traceOf(s.tick(), H1, 'tgt.ep1').egress).toBe('h1.eth0');
      s.applyAction({ kind: 'switch.hang', target: 'sw-a' });
      s.tick(120);
      expect(traceOf(s.getSnapshot(), H1, 'tgt.ep1').result).toBe('dropped');
      expect(s.pendingTimers()).toEqual([]);
      expect(s.eventLog().some((e) => e.code.startsWith('net.bond.'))).toBe(false);
      // Power off the hung switch: carrier loss, so the bond fails over in that same tick.
      s.applyAction({ kind: 'switch.fail', target: 'sw-a' });
      const snap = s.tick();
      if (mode === 'no-bond') {
        expect(traceOf(snap, H1, 'tgt.ep1').result).toBe('dropped');
        return;
      }
      expect(traceOf(snap, H1, 'tgt.ep1')).toMatchObject({
        result: 'delivered',
        egress: 'h1.eth1',
      });
      expect(codes(snap)).toContain('net.bond.member-down');
    });
  }
});

describe('LACP fallback-ab', () => {
  const lacp: FabricOptions = { mode: 'balance-tcp', mlag: true };

  it('one member timed out: the bond keeps aggregating on the survivor', () => {
    const s = probeSim(fabric(lacp), flows(H1, 'tgt.ep1', 8));
    s.applyAction({ kind: 'hang', target: 'l-h1-eth0' });
    s.tick(5);
    const f = s.getSnapshot().devices['h1.vs1']?.fields;
    expect(f).toMatchObject({
      lacpState: 'partial',
      'member.h1.eth0': 'lacp-down',
      'member.h1.eth1': 'up',
      activeMember: null,
    });
    expect(dropped(traces(s.getSnapshot()))).toEqual([]);
  });

  it('every member timed out: falls back to active-backup until one negotiates again', () => {
    const s = probeSim(fabric(lacp), flows(H1, 'tgt.ep1', 8));
    s.applyAction({ kind: 'hang', target: 'l-h1-eth0' });
    s.applyAction({ kind: 'hang', target: 'l-h1-eth1' });
    s.tick(5);
    let snap = s.getSnapshot();
    expect(snap.devices['h1.vs1']?.fields).toMatchObject({
      lacpState: 'fallback',
      activeMember: 'h1.eth0',
      'member.h1.eth0': 'active',
      'member.h1.eth1': 'backup',
    });
    expect(s.eventLog().filter((e) => e.code === 'net.bond.lacp-fallback')).toHaveLength(1);
    // Both members are hung, so active-backup on them still blackholes everything.
    expect(dropped(traces(snap))).toHaveLength(8);
    expect(new Set(traces(snap).map((t) => t.egress))).toEqual(new Set(['h1.eth0']));

    s.applyAction({ kind: 'unhang', target: 'l-h1-eth1' });
    snap = s.tick();
    expect(snap.devices['h1.vs1']?.fields).toMatchObject({
      lacpState: 'partial',
      'member.h1.eth0': 'lacp-down',
      'member.h1.eth1': 'up',
    });
    expect(codes(snap)).toContain('net.bond.lacp-negotiated');
    expect(dropped(traces(snap))).toEqual([]);
  });

  it('without fallback-ab the bond goes down instead', () => {
    const s = probeSim(
      fabric({ ...lacp, config: { lacpFallbackAb: false } }),
      flows(H1, 'tgt.ep1', 2),
    );
    s.applyAction({ kind: 'hang', target: 'l-h1-eth0' });
    s.applyAction({ kind: 'hang', target: 'l-h1-eth1' });
    s.tick(5);
    expect(s.getSnapshot().devices['h1.vs1']?.fields.lacpState).toBe('down');
    expect(s.eventLog().some((e) => e.code === 'net.bond.down')).toBe(true);
  });
});

describe('balance-slb rebalance preconditions (OVS bond_rebalance)', () => {
  it('never moves the only loaded hash off a member, however uneven the load', () => {
    const s = probeSim(
      fabric({ mode: 'balance-slb', config: { slbRebalanceIntervalS: 5 } }),
      flows(H1, 'tgt.ep0', 10),
    );
    s.tick(20);
    expect(s.eventLog().some((e) => e.code === 'net.bond.rebalance')).toBe(false);
    expect(new Set(traces(s.getSnapshot()).map((t) => t.egress)).size).toBe(1);
  });
});
