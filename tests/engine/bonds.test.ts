import { describe, expect, it } from 'vitest';
import type { EngineTrace } from '../../src/engine';
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

/** `n` TCP flows from one source MAC/IP, distinguished by source port. */
function flows(src: string, dst: string, n: number, extra: Partial<Probe> = {}): Probe[] {
  return Array.from({ length: n }, (_, i) => ({ src, dst, srcPort: 40000 + i, ...extra }));
}

const egresses = (ts: readonly EngineTrace[]) => [...new Set(ts.map((t) => t.egress))].sort();
const dropped = (ts: readonly EngineTrace[]) => ts.filter((t) => t.result === 'dropped');

describe('active-backup', () => {
  it('fails over on carrier loss, does not fail back, and chains causes', () => {
    const s = probeSim(fabric(), [{ src: H1, dst: 'tgt.ep0' }]);
    expect(traceOf(s.tick(), H1, 'tgt.ep0').egress).toBe('h1.eth0');
    s.applyAction({ kind: 'link-down', target: 'l-h1-eth0' });
    let snap = s.tick();
    expect(traceOf(snap, H1, 'tgt.ep0')).toMatchObject({
      result: 'delivered',
      links: ['l-h1-eth1', 'l-isl', 'l-tgt-p0'],
    });
    expect(codes(snap)).toEqual([
      'action.link-down',
      'net.link.down',
      'net.bond.member-down',
      'net.bond.failover',
    ]);
    const failover = snap.events.find((e) => e.code === 'net.bond.failover');
    expect(s.causalChain(`e${failover?.seq}`).map((e) => e.code)).toEqual([
      'action.link-down',
      'net.link.down',
      'net.bond.failover',
    ]);
    expect(snap.devices['h1.vs1']?.fields).toMatchObject({
      active: 'h1.eth1',
      'member.h1.eth0': 'down',
      'member.h1.eth1': 'active',
    });

    s.applyAction({ kind: 'link-up', target: 'l-h1-eth0' });
    snap = s.tick();
    expect(traceOf(snap, H1, 'tgt.ep0').egress).toBe('h1.eth1'); // no failback
    expect(snap.devices['h1.vs1']?.fields['member.h1.eth0']).toBe('backup');
  });

  it('VLAN-aware: uses a backup for a VLAN the active uplink does not carry', () => {
    const strictAB: FabricOptions = { vlansA: [10], vlansB: [20] };
    const probes = [
      { src: H1, dst: 'tgt.ep0' },
      { src: 'h1.cvm.ep20', dst: 'tgt.ep20' },
    ];
    const aware = probeSim(fabric(strictAB), probes).tick();
    expect(traceOf(aware, H1, 'tgt.ep0')).toMatchObject({ result: 'delivered', egress: 'h1.eth0' });
    expect(traceOf(aware, 'h1.cvm.ep20', 'tgt.ep20')).toMatchObject({
      result: 'delivered',
      egress: 'h1.eth1',
      links: ['l-h1-eth1', 'l-tgt-p1'],
    });

    const literal = probeSim(fabric({ ...strictAB, slbVlanAware: false }), probes).tick();
    expect(traceOf(literal, 'h1.cvm.ep20', 'tgt.ep20')).toMatchObject({
      result: 'dropped',
      reason: 'vlan-not-carried',
      dropAt: 'sw-a',
    });
  });
});

describe('balance-slb (MAC pinning)', () => {
  it('pins every flow of a MAC+VLAN to one uplink and spreads MACs', () => {
    const s = probeSim(fabric({ mode: 'balance-slb' }), [
      ...flows(H1, 'tgt.ep0', 6),
      ...flows('h1.cvm.ep20', 'tgt.ep20', 6),
      { src: 'tgt.ep0', dst: H1 },
    ]);
    const snap = s.tick();
    const ts = traces(snap);
    const a = egresses(ts.filter((t) => t.src === H1));
    const b = egresses(ts.filter((t) => t.src === 'h1.cvm.ep20'));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a).not.toEqual(b);
    // The switches learned H1's MAC on its pinned uplink, so return traffic enters there.
    const back = traceOf(snap, 'tgt.ep0', H1);
    expect(back.links.at(-1)).toBe(a[0] === 'h1.eth0' ? 'l-h1-eth0' : 'l-h1-eth1');
    expect(s.net.bond('h1.vs1')?.pinnedMember('02:00:00:00:01:10', 10)).toBe(a[0]);
  });

  it('rebalances hash buckets by load on the configured interval', () => {
    const net = fabric({ mode: 'balance-slb', h1Vms: 3, config: { slbRebalanceIntervalS: 5 } });
    const s = probeSim(net, [
      ...flows('h1.vm0', 'tgt.ep0', 5),
      ...flows('h1.vm1', 'tgt.ep0', 1),
      ...flows('h1.vm2', 'tgt.ep0', 5),
    ]);
    const pins = () =>
      ['h1.vm0', 'h1.vm1', 'h1.vm2'].map(
        (vm) => egresses(traces(s.getSnapshot()).filter((t) => t.src === vm))[0],
      );
    s.tick(4);
    expect(pins()).toEqual(['h1.eth0', 'h1.eth1', 'h1.eth0']);
    expect(codes(s.tick())).toEqual(['net.bond.rebalance']); // t=5
    s.tick();
    const after = pins();
    expect(after[1]).toBe('h1.eth1');
    expect(new Set([after[0], after[2]])).toEqual(new Set(['h1.eth0', 'h1.eth1']));
  });

  it('VLAN-aware rebalance never moves a VLAN onto an uplink that lacks it; OVS-literal does', () => {
    const base: FabricOptions = {
      mode: 'balance-slb',
      h1Vms: 3,
      vlansA: [10],
      vlansB: [20],
      config: { slbRebalanceIntervalS: 5 },
    };
    const probes = [
      ...flows('h1.vm0', 'tgt.ep0', 5),
      ...flows('h1.vm1', 'tgt.ep0', 5),
      ...flows('h1.vm2', 'tgt.ep0', 5),
    ];
    const aware = probeSim(fabric(base), probes);
    aware.tick(6);
    expect(egresses(traces(aware.getSnapshot()))).toEqual(['h1.eth0']);
    expect(dropped(traces(aware.getSnapshot()))).toEqual([]);

    const literal = probeSim(fabric({ ...base, slbVlanAware: false }), probes);
    expect(dropped(traces(literal.tick()))).toHaveLength(5); // vm1 pinned to eth1 from the start
    literal.tick(5);
    const lost = dropped(traces(literal.getSnapshot()));
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.every((t) => t.reason === 'vlan-not-carried' && t.egress === 'h1.eth1')).toBe(true);
  });

  it('moves a dead uplink’s MACs to a survivor', () => {
    const s = probeSim(fabric({ mode: 'balance-slb' }), [
      { src: H1, dst: 'tgt.ep0' },
      { src: 'h1.cvm.ep20', dst: 'tgt.ep20' },
    ]);
    s.tick();
    s.applyAction({ kind: 'fail', target: 'h1.eth1' });
    const ts = traces(s.tick());
    expect(egresses(ts)).toEqual(['h1.eth0']);
    expect(dropped(ts)).toEqual([]);
  });
});

describe('balance-tcp (LACP)', () => {
  it('spreads several TCP flows from one MAC across both uplinks (MLAG)', () => {
    const s = probeSim(fabric({ mode: 'balance-tcp', mlag: true }), [
      ...flows(H1, 'tgt.ep0', 8),
      ...flows('tgt.ep0', H1, 4),
    ]);
    const snap = s.tick();
    const out = traces(snap).filter((t) => t.src === H1);
    expect(egresses(out)).toEqual(['h1.eth0', 'h1.eth1']);
    expect(dropped(traces(snap))).toEqual([]);
    expect(snap.devices['h1.vs1']?.status).toBe('healthy');
    expect(snap.devices['h1.vs1']?.fields.misconfig).toBeNull();
  });

  it('flags LACP across two switches without MLAG and uses only one partner', () => {
    const s = probeSim(fabric({ mode: 'balance-tcp' }), flows(H1, 'tgt.ep1', 8));
    const init = s.eventLog().filter((e) => e.code === 'net.bond.lacp-no-mlag');
    expect(init.map((e) => e.deviceId)).toEqual(['h1.vs1', 'h2.vs1']);
    let snap = s.tick();
    expect(egresses(traces(snap))).toEqual(['h1.eth0']);
    expect(snap.devices['h1.vs1']).toMatchObject({ status: 'degraded' });
    expect(snap.devices['h1.vs1']?.fields).toMatchObject({
      'member.h1.eth0': 'up',
      'member.h1.eth1': 'detached',
    });
    expect(String(snap.devices['h1.vs1']?.fields.misconfig)).toMatch(/^lacp-no-mlag/);

    // The surviving partner takes over when the aggregated switch dies.
    s.applyAction({ kind: 'fail', target: 'sw-a' });
    snap = s.tick();
    expect(egresses(traces(snap))).toEqual(['h1.eth1']);
    expect(dropped(traces(snap))).toEqual([]);

    // Enabling MLAG on both switches makes one aggregator.
    s.applyAction({ kind: 'recover', target: 'sw-a' });
    s.applyAction({
      kind: 'fabric.set-mlag',
      target: 'sw-a',
      params: { enabled: 'on', domain: 'p' },
    });
    s.applyAction({
      kind: 'fabric.set-mlag',
      target: 'sw-b',
      params: { enabled: 'on', domain: 'p' },
    });
    snap = s.tick();
    expect(codes(snap)).toContain('net.bond.lacp-aggregated');
    expect(snap.devices['h1.vs1']?.fields.misconfig).toBeNull();
    s.applyAction({ kind: 'fabric.set-mlag', target: 'sw-a', params: { enabled: 'off' } });
    snap = s.tick();
    expect(snap.devices['sw-b']?.fields.mlagDomain).toBeNull();
    expect(codes(snap)).toContain('net.bond.lacp-no-mlag');
  });

  it('carrier loss is detected immediately: no drops in the failure tick', () => {
    const s = probeSim(fabric({ mode: 'balance-tcp', mlag: true }), flows(H1, 'tgt.ep1', 8));
    s.tick();
    s.applyAction({ kind: 'link-down', target: 'l-h1-eth0' });
    const ts = traces(s.tick());
    expect(dropped(ts)).toEqual([]);
    expect(egresses(ts)).toEqual(['h1.eth1']);
  });

  it('a hung uplink blackholes its hashes until LACP fast detection (3 s)', () => {
    const s = probeSim(fabric({ mode: 'balance-tcp', mlag: true }), flows(H1, 'tgt.ep1', 8));
    s.applyAction({ kind: 'hang', target: 'l-h1-eth0' });
    const drops: number[] = [];
    for (let i = 0; i < 6; i++) drops.push(dropped(traces(s.tick())).length);
    const lost = drops[0] ?? 0;
    expect(lost).toBeGreaterThan(0);
    expect(drops).toEqual([lost, lost, lost, lost, 0, 0]); // T=1..4 lost; detected at T=4
    const timeout = s.eventLog().find((e) => e.code === 'net.bond.lacp-timeout');
    expect(timeout?.t).toBe(4);
    expect(s.causalChain(`e${timeout?.seq}`)[0]?.code).toBe('action.hang');
    expect(s.getSnapshot().devices['h1.vs1']?.fields['member.h1.eth0']).toBe('lacp-down');
    expect(s.getSnapshot().links['l-h1-eth0']?.status).toBe('up'); // carrier never dropped
  });

  it('slow LACP takes 90 s; runUntilNextTimer fast-forwards to detection', () => {
    const s = probeSim(
      fabric({ mode: 'balance-tcp', mlag: true, lacpRate: 'slow' }),
      flows(H1, 'tgt.ep1', 8),
    );
    s.applyAction({ kind: 'hang', target: 'h1.eth0' });
    const first = s.tick();
    expect(first.nextTimerAt).toBe(91);
    expect(dropped(traces(first))[0]).toMatchObject({ reason: 'port-down', detail: 'hung' });
    expect(dropped(traces(s.runUntilNextTimer())).length).toBeGreaterThan(0); // T=91 still lost
    expect(s.getSnapshot().simTime).toBe(91);
    expect(dropped(traces(s.tick()))).toEqual([]);
  });

  it('a hung switch (no carrier loss) is detected on every host bond', () => {
    const s = probeSim(fabric({ mode: 'balance-tcp', mlag: true }), [
      ...flows(H1, 'tgt.ep1', 8),
      ...flows('h2.cvm.ep10', 'tgt.ep1', 8),
    ]);
    s.applyAction({ kind: 'hang', target: 'sw-a' });
    const t1 = dropped(traces(s.tick()));
    expect(t1.length).toBeGreaterThan(0);
    expect(t1.every((t) => t.reason === 'device-down' && t.dropAt === 'sw-a')).toBe(true);
    s.tick(3);
    expect(dropped(traces(s.tick()))).toEqual([]);
    expect(s.getSnapshot().devices['sw-a']?.status).toBe('stalled');
  });

  it('active-backup never detects a hung active uplink', () => {
    const s = probeSim(fabric(), [{ src: H1, dst: 'tgt.ep0' }]);
    s.applyAction({ kind: 'hang', target: 'l-h1-eth0' });
    s.tick(100);
    expect(traceOf(s.getSnapshot(), H1, 'tgt.ep0')).toMatchObject({
      result: 'dropped',
      reason: 'link-down',
      detail: 'hung',
    });
    expect(s.pendingTimers()).toEqual([]);
    s.applyAction({ kind: 'unhang', target: 'l-h1-eth0' });
    expect(traceOf(s.tick(), H1, 'tgt.ep0').result).toBe('delivered');
  });
});

describe('runtime bond configuration', () => {
  it('changes the bond mode for every bond in the virtual-switch group', () => {
    const s = probeSim(fabric({ mlag: true }), flows(H1, 'tgt.ep0', 8));
    expect(egresses(traces(s.tick()))).toEqual(['h1.eth0']);
    expect(s.availableActions('h1.vs1').map((a) => a.kind)).toEqual(
      expect.arrayContaining([
        'vswitch.set-bond-mode',
        'vswitch.set-uplinks',
        'vswitch.set-lacp-rate',
      ]),
    );
    s.applyAction({
      kind: 'vswitch.set-bond-mode',
      target: 'h1.vs1',
      params: { mode: 'balance-tcp' },
    });
    const snap = s.tick();
    expect(egresses(traces(snap))).toEqual(['h1.eth0', 'h1.eth1']);
    expect(snap.devices['h2.vs1']?.fields.mode).toBe('balance-tcp');
    expect(codes(snap).filter((c) => c === 'net.bond.mode-changed')).toHaveLength(2);
  });

  it('sets uplinks from the cabled members and rejects others', () => {
    const net = fabric();
    const spec = {
      ...net,
      bonds: (net.bonds ?? []).map((b) =>
        b.id === 'h1.vs1' ? { ...b, uplinks: ['h1.eth1'], members: ['h1.eth0', 'h1.eth1'] } : b,
      ),
    };
    const s = probeSim(spec, [{ src: H1, dst: 'tgt.ep0' }]);
    let snap = s.tick();
    expect(traceOf(snap, H1, 'tgt.ep0').egress).toBe('h1.eth1');
    expect(snap.devices['h1.vs1']?.fields['member.h1.eth0']).toBe('not-uplink');
    s.applyAction({
      kind: 'vswitch.set-uplinks',
      target: 'h1.vs1',
      params: { uplinks: 'h1.eth0, h1.eth1' },
    });
    s.applyAction({ kind: 'link-down', target: 'l-h1-eth1' });
    snap = s.tick();
    expect(traceOf(snap, H1, 'tgt.ep0').egress).toBe('h1.eth0');
    s.applyAction({
      kind: 'vswitch.set-uplinks',
      target: 'h1.vs1',
      params: { uplinks: 'h2.eth0' },
    });
    snap = s.tick();
    expect(snap.events.find((e) => e.code === 'action.rejected')?.text).toMatch(
      /not a cabled member/,
    );
  });

  it('changes the LACP rate group-wide and restarts a pending detection', () => {
    const s = probeSim(fabric({ mode: 'balance-tcp', mlag: true }), flows(H1, 'tgt.ep1', 8));
    s.applyAction({ kind: 'hang', target: 'l-h1-eth0' });
    s.tick();
    expect(s.pendingTimers().map((t) => t.dueAt)).toEqual([4]);
    s.applyAction({ kind: 'vswitch.set-lacp-rate', target: 'h2.vs1', params: { rate: 'slow' } });
    s.tick();
    expect(s.pendingTimers().map((t) => t.dueAt)).toEqual([92]);
    expect(s.getSnapshot().devices['h1.vs1']?.fields.lacpRate).toBe('slow');
  });

  it('no-bond uses only the first uplink', () => {
    const s = probeSim(fabric({ mode: 'no-bond' }), flows(H1, 'tgt.ep0', 4));
    let snap = s.tick();
    expect(egresses(traces(snap))).toEqual(['h1.eth0']);
    expect(snap.devices['h1.vs1']?.fields['member.h1.eth1']).toBe('unused');
    s.applyAction({ kind: 'link-down', target: 'l-h1-eth0' });
    snap = s.tick();
    expect(dropped(traces(snap)).map((t) => t.reason)).toEqual(Array(4).fill('bond-no-member'));
  });

  it('toggles VLAN awareness at runtime', () => {
    const s = probeSim(fabric({ vlansA: [10], vlansB: [20] }), [
      { src: 'h1.cvm.ep20', dst: 'tgt.ep20' },
    ]);
    expect(s.tick().traces[0]?.result).toBe('delivered');
    s.applyAction({
      kind: 'vswitch.set-slb-vlan-aware',
      target: 'h1.vs1',
      params: { enabled: 'off' },
    });
    expect(s.tick().traces[0]?.reason).toBe('vlan-not-carried');
  });
});
