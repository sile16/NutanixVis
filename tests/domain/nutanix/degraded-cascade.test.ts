/**
 * A half-reachable CVM (SPEC §6.2 "Degraded Node Detection"): heavy packet loss on its cluster
 * network (`cvm.network-loss` at or above `dnd.partialLossPct`). Its own Stargate drops out at its
 * ZK session expiry, but it keeps its metadata role, so peer Stargates fail fast after
 * `cluster.stargateHungOpS` and stay down until it is marked Degraded (`dnd.partialConvictionS`):
 * every VM crashes at the initiator session timeout first. Light loss only makes it an outlier; a
 * fully cut-off CVM is dead, not degraded, and causes no fail-fast wave. Times come from the
 * profile.
 */
import { describe, expect, it } from 'vitest';
import { current as P } from '../../../src/domain/versions/profiles/current';
import { harness } from './harness';

const ZK = P.hci.stargateDownDetectS.value;
const HUNG = P.cluster.stargateHungOpS.value;
const INIT = P.redirector.initiatorSessionTimeoutS.value;
const CONVICT = P.dnd.partialConvictionS.value;
const HEAVY = Math.max(P.dnd.partialLossPct.value, 50);
const LIGHT = Math.floor(P.dnd.partialLossPct.value / 2);
const T = 11;
const LOSSY = 'node-1.cvm';
const PEERS = ['node-2.cvm', 'node-3.cvm', 'node-4.cvm'];

describe('profile ordering for the degraded-node cascade', () => {
  it('ZK expiry < hung-op fail-fast < VM crash < DND conviction', () => {
    expect(ZK).toBeLessThan(HUNG);
    expect(HUNG + INIT).toBeLessThan(CONVICT);
    expect(P.dnd.partialLossPct.confidence).toBe('assumption');
    expect(P.cluster.stargateHungOpS.confidence).toBe('assumption');
  });
});

describe('a half-reachable CVM (heavy loss on its cluster network)', () => {
  for (const topology of ['t1-ahv-flasharray', 't2-hci-ahv'] as const) {
    it(`${topology}: own Stargate out, peers fail fast, VMs crash, then Degraded and restart`, () => {
      const h = harness(topology);
      h.run(10);
      h.act('cvm.network-loss', LOSSY, { pct: HEAVY });
      h.run(CONVICT + 120);
      const zk = h.firstAt('stargate.zk-session-lost', LOSSY);
      expect(zk).not.toBeNull();
      expect(zk ?? 0).toBeGreaterThanOrEqual(T + ZK);
      for (const p of PEERS) {
        const t = h.firstAt('stargate.hung-op-fail-fast', p);
        expect(t, p).not.toBeNull();
        expect(t ?? 0, p).toBeGreaterThanOrEqual(T + HUNG);
        expect(t ?? 0, p).toBeLessThanOrEqual(T + HUNG + 2);
      }
      const crash = h.firstAt('vm.crashed');
      const degraded = h.firstAt('dnd.node.degraded', LOSSY);
      expect(crash).not.toBeNull();
      expect(crash ?? 0).toBeGreaterThanOrEqual(T + HUNG + INIT - 1);
      expect(degraded).not.toBeNull();
      expect(degraded ?? 0).toBeGreaterThanOrEqual(T + CONVICT);
      expect(crash ?? 0).toBeLessThan(degraded ?? 0);
      expect(h.firstAt('ha.vm.restarted', undefined, degraded ?? 0)).not.toBeNull();
      expect(h.f(LOSSY, 'dndState')).toBe('degraded');
      for (const p of PEERS) expect(h.f(p, 'stargate'), p).toBe('up');
    });
  }

  it('loss cleared before the hung-op threshold: only a redirect, no fail-fast, no crash', () => {
    const h = harness('t1-ahv-flasharray');
    h.run(10);
    h.act('cvm.network-loss', LOSSY, { pct: HEAVY });
    h.run(ZK + 5);
    h.act('cvm.network-loss', LOSSY, { pct: 0 });
    h.run(CONVICT + 60);
    expect(h.firstAt('stargate.zk-session-lost', LOSSY)).not.toBeNull();
    expect(h.firstAt('stargate.hung-op-fail-fast')).toBeNull();
    expect(h.firstAt('vm.crashed')).toBeNull();
    expect(h.f(LOSSY, 'stargate')).toBe('up');
  });

  it('marking the node fixed while it is still lossy brings the hang back', () => {
    const h = harness('t1-ahv-flasharray');
    h.run(10);
    h.act('cvm.network-loss', LOSSY, { pct: HEAVY });
    h.run(CONVICT + 30);
    expect(h.f(LOSSY, 'dndState')).toBe('degraded');
    const fixedAt = h.run(0).simTime;
    h.act('cvm.mark-fixed', LOSSY);
    h.run(HUNG + 5);
    expect(h.firstAt('stargate.hung-op-fail-fast', 'node-2.cvm', fixedAt + 1)).not.toBeNull();
  });
});

describe('light loss and a dead node do not cascade', () => {
  it('light loss: outlier scores only', () => {
    const h = harness('t1-ahv-flasharray');
    h.run(10);
    h.act('cvm.network-loss', LOSSY, { pct: LIGHT });
    h.run(CONVICT + 60);
    expect(h.firstAt('dnd.outlier', LOSSY)).not.toBeNull();
    expect(h.firstAt('stargate.zk-session-lost')).toBeNull();
    expect(h.firstAt('stargate.hung-op-fail-fast')).toBeNull();
    expect(h.firstAt('vm.crashed')).toBeNull();
    expect(h.f(LOSSY, 'dndState')).toBe('ok');
  });

  it('a fully cut-off CVM is dead: its Stargate drops out, peers keep serving', () => {
    const h = harness('t1-ahv-flasharray');
    h.run(10);
    h.act('cvm.network-flap', LOSSY, { durationS: 120 });
    h.run(120 + 60);
    expect(h.firstAt('stargate.zk-session-lost', LOSSY)).not.toBeNull();
    expect(h.firstAt('stargate.hung-op-fail-fast')).toBeNull();
    expect(h.firstAt('vm.crashed')).toBeNull();
  });
});
