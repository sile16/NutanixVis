/**
 * `vswitch.rebalance { vnic, member }` (SPEC §7.2 T1-16): force the balance-slb pin of one vNIC
 * onto a member, plain-OVS style, so a rebalance can strand a VLAN deterministically.
 */
import { describe, expect, it } from 'vitest';
import { codes, fabric, probeSim, traceOf } from './helpers';

const EP10 = 'h1.cvm.ep10';
const STRICT_AB = { mode: 'balance-slb' as const, vlansA: [10], vlansB: [20] };

const rebalance = (vnic: string, member: string, target = 'h1.vs1') => ({
  kind: 'vswitch.rebalance',
  target,
  params: { vnic, member },
});

describe('vswitch.rebalance', () => {
  it('pins the vNIC to the member even if its switch lacks the VLAN, and says so', () => {
    const s = probeSim(fabric(STRICT_AB), [{ src: EP10, dst: 'tgt.ep0' }]);
    let snap = s.tick();
    expect(traceOf(snap, EP10, 'tgt.ep0')).toMatchObject({
      result: 'delivered',
      egress: 'h1.eth0',
    });
    s.applyAction(rebalance(EP10, 'h1.eth1'));
    snap = s.tick();
    expect(codes(snap)).toEqual(['action.vswitch.rebalance', 'net.bond.rebalance']);
    const ev = snap.events.find((e) => e.code === 'net.bond.rebalance');
    expect(ev).toMatchObject({ severity: 'info', deviceId: 'h1.vs1' });
    expect(ev?.text).toContain(EP10);
    expect(s.causalChain(`e${ev?.seq}`).map((e) => e.code)).toEqual([
      'action.vswitch.rebalance',
      'net.bond.rebalance',
    ]);
    expect(traceOf(snap, EP10, 'tgt.ep0')).toMatchObject({
      result: 'dropped',
      egress: 'h1.eth1',
      reason: 'vlan-not-carried',
    });
    const e = s.net.endpoint(EP10);
    expect(e && s.net.bond('h1.vs1')?.pinnedMember(e.mac, e.vlan)).toBe('h1.eth1');
    // No carrier event: nothing failed.
    expect(codes(snap).some((c) => c.startsWith('net.link.'))).toBe(false);
  });

  it('survives periodic rebalancing and ends when the member leaves service', () => {
    const s = probeSim(fabric(STRICT_AB), [{ src: EP10, dst: 'tgt.ep0' }]);
    s.tick();
    s.applyAction(rebalance(EP10, 'h1.eth1'));
    s.tick(35);
    expect(traceOf(s.getSnapshot(), EP10, 'tgt.ep0').egress).toBe('h1.eth1');
    s.applyAction({ kind: 'link-down', target: 'l-h1-eth1' });
    const snap = s.tick();
    expect(traceOf(snap, EP10, 'tgt.ep0')).toMatchObject({
      result: 'delivered',
      egress: 'h1.eth0',
    });
  });

  it('is offered only for balance-slb bonds and rejects bad parameters', () => {
    const ab = probeSim(fabric({ mode: 'active-backup' }), []);
    expect(ab.availableActions('h1.vs1').map((a) => a.kind)).not.toContain('vswitch.rebalance');
    const s = probeSim(fabric(STRICT_AB), []);
    expect(s.availableActions('h1.vs1').map((a) => a.kind)).toContain('vswitch.rebalance');
    s.applyAction(rebalance('h2.cvm.ep10', 'h1.eth1'));
    s.applyAction(rebalance(EP10, 'h2.eth1'));
    s.applyAction({ kind: 'link-down', target: 'l-h1-eth1' });
    s.applyAction(rebalance(EP10, 'h1.eth1'));
    const snap = s.tick();
    expect(snap.events.filter((e) => e.code === 'action.rejected')).toHaveLength(3);
    expect(codes(snap)).not.toContain('net.bond.rebalance');
  });
});
