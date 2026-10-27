/**
 * iSCSI redirector / Autopath boundaries (Bible 5b; Nutanix blog "controller failure"):
 * unhealthy after `missesToUnhealthy` NOP misses within `missWindowS`, IO held `redirectStallS`
 * on the switch, failback after `failbackStableS` of stability. Times are read from the profile.
 */
import { describe, expect, it } from 'vitest';
import { current as P } from '../../../src/domain/versions/profiles/current';
import { harness, vmState } from './harness';

const R = P.redirector;
const NOP = R.nopIntervalS.value;
const DETECT = R.missesToUnhealthy.value * NOP;

describe('redirector on HCI (T2): CVM failure', () => {
  it('marks the local Stargate unhealthy on the miss rule, not before', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('fail', 'node-1.cvm');
    // The failure applies at T = 11; NOPs at T, T+1, … miss.
    const T = 11;
    h.run(DETECT - 1);
    expect(h.firstAt('redirector.unhealthy', 'node-1')).toBeNull();
    h.run(1);
    expect(h.firstAt('redirector.unhealthy', 'node-1')).toBe(T + DETECT - 1);
    expect(h.firstAt('redirector.redirect', 'node-1')).toBe(T + DETECT - 1);
  });

  it('holds IO for the redirect stall, then serves it from a remote Stargate', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('fail', 'node-1.cvm');
    const redirectAt = 11 + DETECT - 1;
    h.run(redirectAt - 10);
    const stall = R.redirectStallS.value;
    // During the stall no IO of node-1's VMs completes.
    for (let i = 0; i < stall - 1; i++) {
      h.run(1);
      expect(vmState(h, 'node-1.vm-1')).toBe('io-stalled');
    }
    h.run(1);
    expect(h.s().simTime).toBe(redirectAt + stall);
    expect(vmState(h, 'node-1.vm-1')).toBe('running');
    const owner = h.f('node-1.vm-1', 'ownerCvm');
    expect(owner).not.toBe('node-1.cvm');
    expect(h.f('node-1.vm-1', 'host')).toBe('node-1');
    // Worst-case IO wait: detection + stall (SPEC §6.4a).
    expect(Number(h.f('node-1.vm-1', 'ioPendingS'))).toBe(0);
    // No HA event: the VM keeps running on its host (AHV Admin Guide 11.2).
    expect(h.firstAt('ha.host.disconnected')).toBeNull();
  });

  it('fails back exactly failbackStableS after the recovered Stargate starts answering', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('fail', 'node-1.cvm');
    h.run(20);
    h.act('recover', 'node-1.cvm');
    const up = h.until((s) => s.events.some((e) => e.code === 'stargate.up'), 400);
    expect(up).toBe(31 + P.cluster.cvmBootS.value);
    if (up === null) return;
    // First answered NOP is at up+1; failback when it has been answering failbackStableS.
    const due = up + 1 + R.failbackStableS.value;
    h.run(due - 1 - up);
    expect(h.firstAt('redirector.failback', 'node-1')).toBeNull();
    h.run(1);
    expect(h.firstAt('redirector.failback', 'node-1')).toBe(due);
    h.run(R.redirectStallS.value);
    expect(h.f('node-1.vm-1', 'ownerCvm')).toBe('node-1.cvm');
    expect(vmState(h, 'node-1.vm-1')).toBe('running');
  });

  it('cvm.stop-stargate redirects; cvm.start-stargate fails back after the stable period', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('cvm.stop-stargate', 'node-2.cvm');
    h.run(10);
    expect(h.f('node-2.cvm', 'stargate')).toBe('down');
    expect(h.f('node-2.cvm', 'state')).toBe('up');
    expect(h.firstAt('redirector.redirect', 'node-2')).toBe(11 + DETECT - 1);
    h.act('cvm.start-stargate', 'node-2.cvm');
    h.run(1);
    expect(h.firstAt('stargate.up', 'node-2.cvm')).toBe(21);
    // The start applies before that tick's NOP, which is already answered.
    h.run(R.failbackStableS.value + 2);
    expect(h.firstAt('redirector.failback', 'node-2')).toBe(21 + R.failbackStableS.value);
  });

  it('a single missed NOP does not redirect', () => {
    const h = harness('t2-hci-ahv', { 'vs0-bond-mode': 'no-bond' });
    h.run(10);
    // Local Stargate is on virbr0: an uplink failure never touches it.
    h.act('fail', 'node-1.eth0');
    h.run(40);
    expect(h.firstAt('redirector.unhealthy', 'node-1')).toBeNull();
  });
});

describe('redirector on compute-only hosts (T3)', () => {
  it('CO VMs use remote Stargates, spread round-robin over the CVM nodes (assumption)', () => {
    const h = harness('t3-co-so');
    h.run(5);
    const owners = ['node-1.vm-1', 'node-1.vm-2', 'node-2.vm-1', 'node-2.vm-2'].map((v) =>
      h.f(v, 'ownerCvm'),
    );
    expect(owners).toEqual(['node-4.cvm', 'node-5.cvm', 'node-6.cvm', 'node-7.cvm']);
    // The CO host's bond is in the storage path.
    expect(JSON.parse(String(h.f('node-1.vm-1', 'ioUplinks')))).toEqual(['node-1.eth0']);
  });

  it('detects a dead remote Stargate with the same NOP timers (SPEC §14 #5)', () => {
    const h = harness('t3-co-so');
    h.run(10);
    h.act('power-off', 'node-4');
    h.run(DETECT + R.redirectStallS.value);
    expect(h.firstAt('redirector.unhealthy', 'node-1')).toBe(11 + DETECT - 1);
    expect(h.f('node-1.vm-1', 'ownerCvm')).not.toBe('node-4.cvm');
    expect(vmState(h, 'node-1.vm-1')).toBe('running');
    // SO nodes run no VMs: nothing for HA to restart.
    h.run(P.ahvHa.restartByS.value);
    expect(h.firstAt('ha.vm.restarted')).toBeNull();
  });
});
