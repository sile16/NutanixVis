/**
 * Host–CVM internal link lost (SPEC §6.2 "iSCSI redirector"): the host's VM initiators miss
 * their NOPs and log in again through the redirector; a peer Stargate sends each session on to
 * the vDisk leader's external portal while the leader is alive, so the same (local) Stargate keeps
 * serving over the external network after one NOP detection, with no vDisk handover and no ZK
 * expiry. After the link returns the sessions stay on the external path for
 * `externalPathValidityS`, then move back. Times come from the profile.
 */
import { describe, expect, it } from 'vitest';
import { current as P } from '../../../src/domain/versions/profiles/current';
import { type Harness, harness, vmHost, vmState } from './harness';

const R = P.redirector;
const NOP = R.nopIntervalS.value;
const DETECT = R.missesToUnhealthy.value * NOP;
const STALL = R.redirectStallS.value;
const ZK = P.hci.stargateDownDetectS.value;
const VM = 'node-2.vm-1';
const LOCAL = 'node-2.cvm';
const T = 11;

function sessions(h: Harness, host = 'node-2'): Record<string, string> {
  return JSON.parse(String(h.f(host, 'sessions') ?? '{}')) as Record<string, string>;
}

/** Run `ticks` ticks; the VM's worst pending IO. */
function worstPending(h: Harness, ticks: number, vm = VM): number {
  let worst = 0;
  for (let i = 0; i < ticks; i++) {
    h.run(1);
    worst = Math.max(worst, Number(h.f(vm, 'ioPendingS')));
  }
  return worst;
}

function linkDown(topology: 't2-hci-ahv' | 't1-ahv-flasharray' = 't2-hci-ahv'): Harness {
  const h = harness(topology);
  h.run(10);
  h.act('cvm.internal-link-down', LOCAL);
  return h;
}

describe.each(['t2-hci-ahv', 't1-ahv-flasharray'] as const)(
  'host–CVM internal link lost (%s)',
  (topo) => {
    it('stalls for about one NOP detection, then the local Stargate serves over the external path', () => {
      const h = linkDown(topo);
      const worst = worstPending(h, DETECT + 15);
      expect(h.f(LOCAL, 'internalLink')).toBe('down');
      expect(h.firstAt('redirector.unhealthy', 'node-2')).not.toBeNull();
      expect(h.firstAt('redirector.leader-redirect', 'node-2')).not.toBeNull();
      // About one NOP detection, well under the ZK-expiry path of a silent Stargate.
      expect(worst).toBeGreaterThanOrEqual(DETECT - NOP);
      expect(worst).toBeLessThanOrEqual(DETECT + STALL + 2);
      expect(worst).toBeLessThan(ZK + DETECT);
      expect(vmState(h, VM)).toBe('running');
      // The same Stargate keeps the vDisk: no handover, no park, no ZK expiry.
      expect(h.f(VM, 'ownerCvm')).toBe(LOCAL);
      expect(h.firstAt('redirector.parked', 'node-2')).toBeNull();
      expect(h.firstAt('stargate.zk-session-lost')).toBeNull();
      expect(Object.values(sessions(h)).some((v) => v === `${LOCAL} (external)`)).toBe(true);
      // The VM stays on its host; no HA event.
      expect(vmHost(h, VM)).toBe('node-2');
      expect(h.firstAt('ha.host.disconnected')).toBeNull();
    });

    it('after the link returns the sessions stay external, then move back after the validity window', () => {
      const h = linkDown(topo);
      h.run(DETECT + 15);
      h.act('cvm.internal-link-up', LOCAL);
      h.run(60);
      expect(h.f(LOCAL, 'internalLink')).toBe('up');
      // No failback cycle: still on the external portal well after the link is back.
      expect(Object.values(sessions(h)).some((v) => v === `${LOCAL} (external)`)).toBe(true);
      expect(h.firstAt('redirector.failback', 'node-2')).toBeNull();
      expect(h.firstAt('redirector.path-internal', 'node-2')).toBeNull();
      h.run(R.externalPathValidityS.value + 30);
      expect(h.firstAt('redirector.path-internal', 'node-2')).not.toBeNull();
      expect(Object.values(sessions(h)).every((v) => !v.endsWith('(external)'))).toBe(true);
      expect(vmState(h, VM)).toBe('running');
    });
  },
);

describe('the peer redirect to the leader against a dead or hung leader', () => {
  it('a hung leader still parks the session until its ZK expiry (no external shortcut)', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('cvm.hang-stargate', LOCAL);
    h.run(ZK + DETECT + 10);
    expect(h.firstAt('redirector.parked', 'node-2')).not.toBeNull();
    expect(h.firstAt('redirector.leader-redirect', 'node-2')).toBeNull();
    expect(h.f(VM, 'ownerCvm')).not.toBe(LOCAL);
  });

  it('the internal-link stall is shorter than a hung Stargate’s and longer than a stop’s', () => {
    const run = (kind: string) => {
      const h = harness('t2-hci-ahv');
      h.run(10);
      h.act(kind, LOCAL);
      return worstPending(h, ZK + DETECT + 15);
    };
    const stop = run('cvm.stop-stargate');
    const link = run('cvm.internal-link-down');
    const hang = run('cvm.hang-stargate');
    expect(stop).toBeLessThan(link);
    expect(link).toBeLessThan(hang);
    expect(T).toBe(11);
  });
});
