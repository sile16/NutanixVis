import { describe, expect, it } from 'vitest';
import { fabric, type Probe, probeSim } from './helpers';

const H1 = 'h1.cvm.ep10';
const logOf = (
  events: readonly { code: string; log?: { lines: readonly string[] } }[],
  code: string,
) => events.filter((e) => e.code === code).flatMap((e) => e.log?.lines ?? []);

function flows(src: string, dst: string, n: number): Probe[] {
  return Array.from({ length: n }, (_, i) => ({ src, dst, srcPort: 40000 + i }));
}

// The bond's events carry the lines ovs-vswitchd writes (OVS ofproto/bond.c, branch-3.3), in
// the order an AHV host logs them.
describe('bond events carry ovs-vswitchd log lines', () => {
  it('link down and up on balance-slb: link state, disable, active member', () => {
    const s = probeSim(fabric({ mode: 'balance-slb' }), [{ src: H1, dst: 'tgt.ep0' }]);
    s.tick();
    s.applyAction({ kind: 'link-down', target: 'l-h1-eth0' });
    let snap = s.tick();
    const down = snap.events.find((e) => e.code === 'net.bond.member-down');
    expect(down?.log).toEqual({
      source: 'ovs-vswitchd',
      cite: 'ovs-bond-source',
      lines: [
        'bond|INFO|member eth0: link state down',
        'bond|INFO|member eth0: disabled',
        'bond|INFO|bond br1-up: active member is now eth1',
      ],
    });
    s.applyAction({ kind: 'link-up', target: 'l-h1-eth0' });
    snap = s.tick();
    // The active member does not return at restore.
    expect(logOf(snap.events, 'net.bond.member-up')).toEqual([
      'bond|INFO|member eth0: link state up',
      'bond|INFO|member eth0: enabled',
    ]);
  });

  it('all members down: the bond logs "all members disabled"', () => {
    const s = probeSim(fabric({ mode: 'balance-slb' }), [{ src: H1, dst: 'tgt.ep0' }]);
    s.tick();
    s.applyAction({ kind: 'link-down', target: 'l-h1-eth0' });
    s.applyAction({ kind: 'link-down', target: 'l-h1-eth1' });
    const snap = s.tick();
    expect(logOf(snap.events, 'net.bond.down')).toEqual([
      'bond|INFO|bond br1-up: all members disabled',
    ]);
  });

  it('active-backup failover puts the active-member line on the failover event', () => {
    const s = probeSim(fabric(), [{ src: H1, dst: 'tgt.ep0' }]);
    s.tick();
    s.applyAction({ kind: 'link-down', target: 'l-h1-eth0' });
    const snap = s.tick();
    expect(logOf(snap.events, 'net.bond.member-down')).toEqual([
      'bond|INFO|member eth0: link state down',
      'bond|INFO|member eth0: disabled',
    ]);
    expect(logOf(snap.events, 'net.bond.failover')).toEqual([
      'bond|INFO|bond br1-up: active member is now eth1',
    ]);
  });

  it('a slb rebalance logs one shift line per moved bucket, at info', () => {
    const net = fabric({ mode: 'balance-slb', h1Vms: 3, config: { slbRebalanceIntervalS: 5 } });
    const s = probeSim(net, [
      ...flows('h1.vm0', 'tgt.ep0', 5),
      ...flows('h1.vm1', 'tgt.ep0', 1),
      ...flows('h1.vm2', 'tgt.ep0', 5),
    ]);
    s.tick(4);
    const ev = s.tick().events.find((e) => e.code === 'net.bond.rebalance');
    expect(ev?.severity).toBe('info');
    expect(ev?.log?.lines).toHaveLength(1);
    expect(ev?.log?.lines[0]).toMatch(
      /^bond\|INFO\|bond br1-up: shift load \(with hash \d+\) from eth[01] to eth[01]$/,
    );
  });
});
