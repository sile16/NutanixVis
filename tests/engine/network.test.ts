import { describe, expect, it } from 'vitest';
import {
  type ActionDefinition,
  NetworkError,
  NetworkRuntime,
  stringParam,
  TimerQueue,
  validateNetworkSpec,
} from '../../src/engine';
import { device, fabric, fabricDevices, probeSim, traceOf } from './helpers';

const H1 = 'h1.cvm.ep10';

describe('L2 delivery', () => {
  it('takes the direct path on the local switch and the ISL to the far switch', () => {
    const s = probeSim(fabric(), [
      { src: H1, dst: 'tgt.ep0' },
      { src: H1, dst: 'tgt.ep1' },
      { src: 'tgt.ep1', dst: H1 },
    ]);
    const snap = s.tick();
    expect(traceOf(snap, H1, 'tgt.ep0')).toMatchObject({
      result: 'delivered',
      links: ['l-h1-eth0', 'l-tgt-p0'],
      egress: 'h1.eth0',
    });
    expect(traceOf(snap, H1, 'tgt.ep1').links).toEqual(['l-h1-eth0', 'l-isl', 'l-tgt-p1']);
    // Return traffic enters on the active member, where the switches learned the MAC.
    expect(traceOf(snap, 'tgt.ep1', H1).links).toEqual(['l-tgt-p1', 'l-isl', 'l-h1-eth0']);
  });

  it('accumulates illustrative latency along the path', () => {
    const net = fabric();
    const s = probeSim(net, [{ src: H1, dst: 'tgt.ep1' }]);
    s.applyAction({ kind: 'set-latency', target: 'l-isl', params: { ms: 5 } });
    s.applyAction({ kind: 'set-latency', target: 'l-tgt-p1', params: { ms: 1 } });
    const snap = s.tick();
    expect(traceOf(snap, H1, 'tgt.ep1').latencyMs).toBe(6);
    expect(snap.links['l-isl']?.latencyMs).toBe(5);
  });

  it('isolates VLANs: no delivery between endpoints on different VLANs', () => {
    const s = probeSim(fabric(), [{ src: 'h1.cvm.ep20', dst: 'tgt.ep0' }]);
    expect(traceOf(s.tick(), 'h1.cvm.ep20', 'tgt.ep0')).toMatchObject({
      result: 'dropped',
      reason: 'no-route',
      detail: 'different-vlan',
      links: [],
    });
  });

  it('drops where a switch does not carry the VLAN', () => {
    const s = probeSim(fabric({ vlansB: [20] }), [{ src: H1, dst: 'tgt.ep1' }]);
    expect(traceOf(s.tick(), H1, 'tgt.ep1')).toMatchObject({
      result: 'dropped',
      reason: 'vlan-not-carried',
      dropAt: 'sw-b',
      links: ['l-h1-eth0', 'l-isl'],
    });
  });

  it('honors allowedVlans pruning on an ISL, per VLAN', () => {
    const s = probeSim(fabric(), [
      { src: H1, dst: 'tgt.ep1' },
      { src: 'h1.cvm.ep20', dst: 'tgt.ep20' },
    ]);
    expect(s.availableActions('l-isl').map((a) => a.kind)).toContain('switch.port.prune-vlan');
    s.applyAction({ kind: 'switch.port.prune-vlan', target: 'l-isl', params: { vlan: 10 } });
    let snap = s.tick();
    expect(traceOf(snap, H1, 'tgt.ep1')).toMatchObject({
      result: 'dropped',
      reason: 'vlan-not-carried',
      dropAt: 'l-isl',
      links: ['l-h1-eth0', 'l-isl'],
    });
    expect(traceOf(snap, 'h1.cvm.ep20', 'tgt.ep20').result).toBe('delivered');
    expect(s.net.link('l-isl')?.allowedVlans).toEqual([20]);

    s.applyAction({ kind: 'switch.port.allow-vlan', target: 'l-isl', params: { vlan: 10 } });
    snap = s.tick();
    expect(traceOf(snap, H1, 'tgt.ep1').result).toBe('delivered');
  });

  it('strict A/B: losing the only uplink that carries a VLAN drops it at the bond (VLAN-aware)', () => {
    const net = fabric();
    const strict = (vlanAware: boolean) => ({
      ...net,
      links: (net.links ?? []).map((l) =>
        l.id === 'l-h1-eth1' ? { ...l, allowedVlans: [20] } : l,
      ),
      bonds: (net.bonds ?? []).map((b) => ({ ...b, slbVlanAware: vlanAware })),
    });
    const aware = probeSim(strict(true), [{ src: H1, dst: 'tgt.ep0' }]);
    expect(traceOf(aware.tick(), H1, 'tgt.ep0').result).toBe('delivered');
    aware.applyAction({ kind: 'link-down', target: 'l-h1-eth0' });
    expect(traceOf(aware.tick(), H1, 'tgt.ep0')).toMatchObject({
      result: 'dropped',
      reason: 'bond-no-member',
      dropAt: 'h1.vs1',
      detail: 'no-uplink-carries-vlan',
    });

    // OVS-literal: the bond fails over onto an uplink that does not carry the VLAN.
    const literal = probeSim(strict(false), [{ src: H1, dst: 'tgt.ep0' }]);
    literal.applyAction({ kind: 'link-down', target: 'l-h1-eth0' });
    expect(traceOf(literal.tick(), H1, 'tgt.ep0')).toMatchObject({
      result: 'dropped',
      reason: 'vlan-not-carried',
      dropAt: 'l-h1-eth1',
      egress: 'h1.eth1',
    });
  });

  it('bond-attached endpoints stay up when every uplink loses carrier', () => {
    const seen: boolean[] = [];
    const s = probeSim(fabric(), [{ src: H1, dst: 'tgt.ep0' }], {
      devices: [
        ...fabricDevices().filter((d) => d.id !== 'h1.cvm'),
        device('h1.cvm', { parentId: 'h1', postTick: (c) => seen.push(c.net.endpointUp(H1)) }),
      ],
    });
    s.applyAction({ kind: 'fail', target: 'sw-a' });
    s.applyAction({ kind: 'fail', target: 'sw-b' });
    const snap = s.tick();
    expect(seen).toEqual([true]);
    expect(snap.devices['h1.cvm']?.status).toBe('healthy');
    expect(snap.events.filter((e) => e.deviceId === 'h1.cvm')).toEqual([]);
    expect(traceOf(snap, H1, 'tgt.ep0').reason).toBe('bond-no-member');
  });

  it('re-homes a floating endpoint between NICs at runtime', () => {
    let moved = '';
    const mover = device('tgt', {
      preTick(ctx) {
        if (ctx.now === 2) moved = ctx.endpoints.move('tgt.ep0', { kind: 'nic', id: 'tgt.p1' });
      },
    });
    const s = probeSim(fabric(), [{ src: H1, dst: 'tgt.ep0' }], {
      devices: [...fabricDevices().filter((d) => d.id !== 'tgt'), mover],
    });
    expect(traceOf(s.tick(), H1, 'tgt.ep0').links).toEqual(['l-h1-eth0', 'l-tgt-p0']);
    const snap = s.tick();
    expect(traceOf(snap, H1, 'tgt.ep0').links).toEqual(['l-h1-eth0', 'l-isl', 'l-tgt-p1']);
    expect(snap.events.find((e) => `e${e.seq}` === moved)?.code).toBe('net.endpoint.moved');
    expect(s.net.endpoint('tgt.ep0')?.attach).toEqual({ kind: 'nic', id: 'tgt.p1' });
  });

  it('drops large frames where the MTU is too small, but not small ones', () => {
    const s = probeSim(fabric({ switchMtu: 1500 }), [
      { src: H1, dst: 'tgt.ep0', size: 'small' },
      { src: H1, dst: 'tgt.ep0', size: 'large', srcPort: 2 },
    ]);
    const [small, large] = s.tick().traces;
    expect(small?.result).toBe('delivered');
    expect(large).toMatchObject({ result: 'dropped', reason: 'mtu', dropAt: 'l-h1-eth0' });
    expect(s.getSnapshot().links['l-h1-eth0']?.mtu).toBe(1500);
  });

  it('reports net.mtu.mismatch once per dropping link, not per frame', () => {
    const s = probeSim(fabric({ switchMtu: 1500 }), [
      { src: H1, dst: 'tgt.ep0', size: 'large' },
      { src: H1, dst: 'tgt.ep0', size: 'large', srcPort: 2 },
      { src: H1, dst: 'tgt.ep0', size: 'small', srcPort: 3 },
    ]);
    const first = s.tick();
    const mtu = first.events.filter((e) => e.code === 'net.mtu.mismatch');
    expect(mtu.map((e) => e.deviceId)).toEqual(['l-h1-eth0']);
    expect(mtu[0]?.severity).toBe('warn');
    expect(s.tick().events.filter((e) => e.code === 'net.mtu.mismatch')).toEqual([]);
  });

  it('drops large frames at a destination endpoint with a smaller MTU', () => {
    const net = fabric();
    const spec = {
      ...net,
      endpoints: (net.endpoints ?? []).map((e) => (e.id === 'tgt.ep0' ? { ...e, mtu: 1500 } : e)),
    };
    const s = probeSim(spec, [{ src: H1, dst: 'tgt.ep0', size: 'large' }]);
    expect(traceOf(s.tick(), H1, 'tgt.ep0')).toMatchObject({
      result: 'dropped',
      reason: 'mtu',
      detail: 'endpoint-mtu',
      links: ['l-h1-eth0', 'l-tgt-p0'],
    });
  });

  it('internal bridge (virbr0) works with every uplink down', () => {
    const s = probeSim(fabric(), [
      { src: 'h1.hv.int', dst: 'h1.cvm.int' },
      { src: H1, dst: 'tgt.ep0' },
      { src: 'h1.hv.int', dst: 'tgt.ep0' },
    ]);
    s.applyAction({ kind: 'link-down', target: 'l-h1-eth0' });
    s.applyAction({ kind: 'fail', target: 'h1.eth1' });
    const snap = s.tick();
    expect(traceOf(snap, 'h1.hv.int', 'h1.cvm.int')).toMatchObject({
      result: 'delivered',
      links: [],
    });
    expect(traceOf(snap, H1, 'tgt.ep0')).toMatchObject({
      result: 'dropped',
      reason: 'bond-no-member',
      dropAt: 'h1.vs1',
    });
    expect(traceOf(snap, 'h1.hv.int', 'tgt.ep0').reason).toBe('no-route');
    expect(snap.devices['h1.vs1']?.status).toBe('failed');
  });

  it('endpoints sharing a bond talk locally without uplinks', () => {
    const s = probeSim(fabric({ h1Vms: 1 }), [{ src: 'h1.vm0', dst: H1 }]);
    s.applyAction({ kind: 'fail', target: 'sw-a' });
    s.applyAction({ kind: 'fail', target: 'sw-b' });
    expect(traceOf(s.tick(), 'h1.vm0', H1)).toMatchObject({ result: 'delivered', links: [] });
  });

  it('reports device, port, link and endpoint failures as drop reasons', () => {
    const epDown: ActionDefinition = {
      spec: { kind: 'test.endpoint-down', label: 'EP down', appliesTo: () => true },
      apply: (req, ctx) => ctx.net.setEndpointUp(stringParam(req, 'ep'), false),
    };
    const fence: ActionDefinition = {
      spec: { kind: 'test.fence', label: 'Fence', appliesTo: () => true },
      apply: (req, ctx) => ctx.net.setEndpointFenced(stringParam(req, 'ep'), true),
    };
    const s = probeSim(
      fabric(),
      [
        { src: H1, dst: 'tgt.ep0' },
        { src: H1, dst: 'tgt.ep1' },
        { src: 'h2.cvm.ep10', dst: 'tgt.ep1' },
      ],
      { actions: [epDown] },
    );
    s.applyAction({ kind: 'link-down', target: 'l-tgt-p0' });
    s.applyAction({ kind: 'test.endpoint-down', target: 'tgt', params: { ep: 'tgt.ep1' } });
    s.applyAction({ kind: 'fail', target: 'h2.eth0' });
    s.applyAction({ kind: 'fail', target: 'h2.eth1' });
    const snap = s.tick();
    expect(traceOf(snap, H1, 'tgt.ep0')).toMatchObject({
      reason: 'link-down',
      dropAt: 'l-tgt-p0',
      links: ['l-h1-eth0', 'l-tgt-p0'],
    });
    expect(traceOf(snap, H1, 'tgt.ep1')).toMatchObject({ reason: 'endpoint-down', dropAt: 'tgt' });
    expect(traceOf(snap, 'h2.cvm.ep10', 'tgt.ep1').reason).toBe('bond-no-member');
    const s2 = probeSim(fabric(), [{ src: 'h1.cvm.ep20', dst: 'tgt.ep20' }], {
      actions: [fence],
    });
    s2.applyAction({ kind: 'test.fence', target: 'tgt', params: { ep: 'tgt.ep20' } });
    expect(traceOf(s2.tick(), 'h1.cvm.ep20', 'tgt.ep20').reason).toBe('fenced');
  });

  it('drops at a failed switch with device-down', () => {
    const s = probeSim(fabric(), [{ src: 'tgt.ep0', dst: 'tgt.ep1' }]);
    s.applyAction({ kind: 'fail', target: 'sw-b' });
    expect(s.tick().traces[0]).toMatchObject({
      result: 'dropped',
      reason: 'device-down',
      dropAt: 'sw-b',
      links: ['l-tgt-p0', 'l-isl'],
    });
  });

  it('counts per-link utilization by traffic category for the last tick only', () => {
    const s = probeSim(
      fabric(),
      [
        { src: H1, dst: 'tgt.ep1', kind: 'io' },
        { src: H1, dst: 'tgt.ep1', kind: 'hb', srcPort: 2 },
        { src: H1, dst: 'tgt.ep0', kind: 'io', srcPort: 3 },
      ],
      { traffic: { io: 'io-read', hb: 'heartbeat' } },
    );
    let snap = s.tick();
    expect(snap.links['l-h1-eth0']?.util).toEqual({ heartbeat: 1, 'io-read': 2 });
    expect(snap.links['l-isl']?.util).toEqual({ heartbeat: 1, 'io-read': 1 });
    expect(snap.traces.map((t) => t.category)).toEqual(['io-read', 'heartbeat', 'io-read']);
    s.applyAction({ kind: 'fail', target: 'sw-b' });
    snap = s.tick();
    // The link the frame died on is not counted.
    expect(snap.links['l-isl']?.util).toEqual({});
    expect(snap.links['l-h1-eth0']?.util).toEqual({ heartbeat: 1, 'io-read': 2 });
  });
});

describe('network spec validation', () => {
  it('rejects bad specs', () => {
    const ok = fabric();
    expect(() => validateNetworkSpec(ok)).not.toThrow();
    const bad = [
      { ...ok, nics: [...(ok.nics ?? []), { id: 'sw-a' }] },
      { ...ok, links: [...(ok.links ?? []), { id: 'x', a: 'h1.eth0', b: 'sw-b' }] },
      { ...ok, links: [...(ok.links ?? []), { id: 'y', a: 'nope', b: 'sw-b' }] },
      {
        ...ok,
        bonds: [...(ok.bonds ?? []), { id: 'b2', mode: 'no-bond' as const, uplinks: ['h1.eth0'] }],
      },
      { ...ok, switches: [{ id: 'sw-z', vlans: [5000] }] },
    ];
    for (const spec of bad) expect(() => validateNetworkSpec(spec)).toThrow(NetworkError);
  });

  it('runtime rejects unknown ids', () => {
    const net = new NetworkRuntime(fabric(), {
      now: () => 0,
      timers: new TimerQueue(() => 0),
      isDown: () => false,
      emit: () => 'e0',
      causes: () => [],
      withCauses: (_c, fn) => fn(),
    });
    expect(() => net.setLinkUp('nope', false)).toThrow(NetworkError);
    expect(() => net.setBondUplinks('h1.vs1', ['h2.eth0'])).toThrow(/not a cabled member/);
    expect(net.kindOf('h1.vs1')).toBe('bond');
    expect(net.endpointsOf('tgt').map((e) => e.id)).toEqual(['tgt.ep0', 'tgt.ep1', 'tgt.ep20']);
  });
});
