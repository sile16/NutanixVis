/**
 * AHV iSCSI redirector and the VM's initiator (SPEC §6.2 "iSCSI redirector"): a reset connection
 * is noticed at once, a silent Stargate only by `missesToUnhealthy` unanswered initiator NOPs
 * `nopIntervalS` apart; a peer serves a vDisk only once its leadership is released (orderly stop
 * or process exit at once, otherwise at the ZK session expiry), so earlier logins park until the
 * next NOP cycle; failback is one vDisk per `failbackStepS` after `failbackStableS`; a session no
 * Stargate serves for `initiatorSessionTimeoutS` crashes its VM. Times come from the profile.
 */
import { describe, expect, it } from 'vitest';
import { current as P } from '../../../src/domain/versions/profiles/current';
import { type Harness, harness, vmHost, vmState } from './harness';

const R = P.redirector;
const NOP = R.nopIntervalS.value;
const DETECT = R.missesToUnhealthy.value * NOP;
const STALL = R.redirectStallS.value;
const ZK = P.hci.stargateDownDetectS.value;
/** Worst IO pause for a silent Stargate: leadership released at the ZK expiry, then a NOP cycle. */
const SILENT = ZK + DETECT + STALL;
const VM = 'node-1.vm-1';
const T = 11;

/** Run `ticks` ticks after a fault applied at T; the VM's worst pending IO and first resume. */
function watch(h: Harness, ticks: number, vm = VM): { worst: number; resumedAt: number | null } {
  let worst = 0;
  let resumedAt: number | null = null;
  let stalled = false;
  for (let i = 0; i < ticks; i++) {
    const s = h.run(1);
    const pending = Number(h.f(vm, 'ioPendingS'));
    worst = Math.max(worst, pending);
    const state = vmState(h, vm);
    if (state === 'io-stalled') stalled = true;
    else if (stalled && state === 'running' && resumedAt === null) resumedAt = s.simTime;
  }
  return { worst, resumedAt };
}

function faulted(kind: string, target: string, ticks: number, topology = 't2-hci-ahv' as const) {
  const h = harness(topology);
  h.run(10);
  h.act(kind, target);
  return { h, ...watch(h, ticks) };
}

describe('redirector on HCI (T2): how the initiator notices a failed Stargate', () => {
  it('a silent CVM is noticed by the initiator NOPs, not before one NOP interval', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('power-off', 'node-1.cvm');
    h.run(DETECT + NOP);
    const at = h.firstAt('redirector.unhealthy', 'node-1');
    expect(at).not.toBeNull();
    expect(at ?? 0).toBeGreaterThanOrEqual(T + NOP);
    expect(at ?? 0).toBeLessThanOrEqual(T + DETECT);
  });

  it('the first login to a peer parks until the silent Stargate’s ZK session expires', () => {
    const { h, worst, resumedAt } = faulted('power-off', 'node-1.cvm', SILENT + 10);
    expect(h.firstAt('redirector.parked', 'node-1')).not.toBeNull();
    expect(resumedAt).not.toBeNull();
    expect(resumedAt ?? 0).toBeGreaterThanOrEqual(T + ZK);
    expect(worst).toBeLessThanOrEqual(SILENT + 1);
    expect(h.f(VM, 'ownerCvm')).not.toBe('node-1.cvm');
    // No HA event: the VM keeps running on its host (AHV Admin Guide 11.2).
    expect(vmHost(h, VM)).toBe('node-1');
    expect(h.firstAt('ha.host.disconnected')).toBeNull();
  });

  it('an orderly stop resets the connections: re-login at once, no park', () => {
    const { h, worst } = faulted('cvm.stop-stargate', 'node-1.cvm', 20);
    expect(h.firstAt('redirector.redirect', 'node-1')).toBe(T);
    expect(h.firstAt('redirector.parked', 'node-1')).toBeNull();
    expect(worst).toBeLessThanOrEqual(STALL + 1);
  });

  it('a process crash is as quick as a stop, and its self-monitor restarts it', () => {
    const { h, worst } = faulted('cvm.crash-stargate', 'node-1.cvm', 20);
    expect(h.firstAt('stargate.crashed', 'node-1.cvm')).toBe(T);
    expect(h.firstAt('redirector.redirect', 'node-1')).toBe(T);
    expect(worst).toBeLessThanOrEqual(STALL + 1);
    expect(h.firstAt('stargate.up', 'node-1.cvm')).toBe(T + P.cluster.stargateSelfRestartS.value);
  });

  it('a hung Stargate is silent: NOP detection, park, then the peer serves after ZK expiry', () => {
    const { h, worst, resumedAt } = faulted('cvm.hang-stargate', 'node-1.cvm', SILENT + 10);
    expect(h.f('node-1.cvm', 'stargate')).toBe('hung');
    expect(h.firstAt('redirector.unhealthy', 'node-1')).not.toBeNull();
    expect(resumedAt ?? 0).toBeGreaterThanOrEqual(T + ZK);
    expect(worst).toBeLessThanOrEqual(SILENT + 1);
    // Resume: its watchdog fires, the process exits and is restarted.
    h.act('cvm.resume-stargate', 'node-1.cvm');
    h.run(P.cluster.stargateSelfRestartS.value + 2);
    expect(h.firstAt('stargate.crashed', 'node-1.cvm')).not.toBeNull();
    expect(h.f('node-1.cvm', 'stargate')).toBe('up');
  });

  it('orders the stalls: stop ≈ crash ≪ hang ≈ reboot ≈ power-off < initiator timeout', () => {
    const n = SILENT + 10;
    const stop = faulted('cvm.stop-stargate', 'node-1.cvm', n).worst;
    const crash = faulted('cvm.crash-stargate', 'node-1.cvm', n).worst;
    const hang = faulted('cvm.hang-stargate', 'node-1.cvm', n).worst;
    const reboot = faulted('reboot', 'node-1.cvm', n).worst;
    const off = faulted('power-off', 'node-1.cvm', n).worst;
    expect(Math.max(stop, crash)).toBeLessThanOrEqual(STALL + 1);
    for (const silent of [hang, reboot, off]) {
      expect(silent).toBeGreaterThanOrEqual(ZK);
      expect(silent).toBeLessThanOrEqual(SILENT + 1);
      expect(silent).toBeLessThan(R.initiatorSessionTimeoutS.value);
    }
  });

  it('a network blackout is invisible until the ZK session expires, then one NOP cycle', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('cvm.network-flap', 'node-1.cvm', { durationS: 120 });
    // Its Stargate keeps serving the local sessions while it holds its ZK session.
    const before = watch(h, ZK - 1);
    expect(h.firstAt('stargate.zk-session-lost', 'node-1.cvm')).toBeNull();
    const after = watch(h, DETECT + 10);
    expect(h.firstAt('stargate.zk-session-lost', 'node-1.cvm')).toBe(T + ZK);
    expect(after.worst).toBeLessThanOrEqual(DETECT + STALL + 1);
    expect(before.worst).toBeLessThan(after.worst);
    expect(h.f(VM, 'ownerCvm')).not.toBe('node-1.cvm');
  });

  it('fails back one vDisk per step once the restarted Stargate has been stable long enough', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('cvm.crash-stargate', 'node-1.cvm');
    const up = h.until((s) => s.events.some((e) => e.code === 'stargate.up'), 30);
    expect(up).not.toBeNull();
    h.run(R.failbackStableS.value + 4 * R.failbackStepS.value);
    const backs = h
      .events()
      .filter((e) => e.code === 'redirector.failback' && e.deviceId === 'node-1')
      .map((e) => e.t);
    expect(backs.length).toBeGreaterThanOrEqual(2);
    expect((backs[0] ?? 0) - (up ?? 0)).toBeGreaterThanOrEqual(R.failbackStableS.value);
    for (let i = 1; i < backs.length; i++) {
      expect((backs[i] ?? 0) - (backs[i - 1] ?? 0)).toBeGreaterThanOrEqual(R.failbackStepS.value);
    }
    expect(h.f(VM, 'ownerCvm')).toBe('node-1.cvm');
  });

  it('a restart starts the stable period again (failback waits for the last restart)', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('cvm.crash-stargate', 'node-1.cvm');
    h.run(60);
    h.act('cvm.crash-stargate', 'node-1.cvm');
    h.run(1);
    const second = h.s().simTime;
    h.run(R.failbackStableS.value + 30);
    const first = h.firstAt('redirector.failback', 'node-1');
    expect(first).not.toBeNull();
    expect((first ?? 0) - second).toBeGreaterThanOrEqual(R.failbackStableS.value);
  });
});

describe('a long CVM outage', () => {
  it('keeps the VMs on their host and the host schedulable (no migration, no HA)', () => {
    const h = harness('t1-ahv-flasharray');
    h.run(10);
    h.act('power-off', 'node-1.cvm');
    h.run(900);
    expect(vmHost(h, VM)).toBe('node-1');
    expect(vmState(h, VM)).toBe('running');
    expect(h.f('node-1', 'haState')).toBe('connected');
    expect(h.firstAt('ha.vm.restarted')).toBeNull();
    expect(h.firstAt('vm.crashed')).toBeNull();
  });
});

describe('initiator session timeout', () => {
  it('crashes VMs no Stargate has served that long; AHV powers them back on later', () => {
    const h = harness('t1-ahv-flasharray');
    h.run(10);
    for (const n of [1, 2, 3, 4]) h.act('cvm.stop-stargate', `node-${n}.cvm`);
    h.run(R.initiatorSessionTimeoutS.value - 2);
    expect(h.firstAt('vm.crashed')).toBeNull();
    h.run(4);
    // Last served at T − 1 (the stop resets the sessions at T).
    expect(h.firstAt('vm.crashed', VM)).toBe(T - 1 + R.initiatorSessionTimeoutS.value);
    for (const n of [1, 2, 3, 4]) h.act('cvm.start-stargate', `node-${n}.cvm`);
    h.run(2 * P.ahvHa.heartbeatIntervalS.value + 5);
    expect(h.firstAt('ha.vm.restarted', VM)).not.toBeNull();
    expect(vmState(h, VM)).toBe('running');
  });

  it('with whole-array-loss-vm-behavior: stall the VMs keep retrying in place', () => {
    const h = harness('t1-ahv-flasharray', { 'whole-array-loss-vm-behavior': 'stall' });
    h.run(10);
    for (const n of [1, 2, 3, 4]) h.act('cvm.stop-stargate', `node-${n}.cvm`);
    h.run(2 * R.initiatorSessionTimeoutS.value);
    expect(h.firstAt('vm.crashed')).toBeNull();
    expect(vmHost(h, VM)).toBe('node-1');
  });
});

describe('Degraded Node Detection and isolation', () => {
  it('a node unreachable for the whole scoring window is dead, not Degraded', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('cvm.network-flap', 'node-1.cvm', { durationS: 120 });
    h.run(120 + P.dnd.scoringWindowS.value + 30);
    expect(h.f('node-1.cvm', 'dndState')).toBe('ok');
    expect(h.firstAt('dnd.node.degraded')).toBeNull();
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

  it('detects a dead remote Stargate with the same initiator rules (SPEC §14 #5)', () => {
    const h = harness('t3-co-so');
    h.run(10);
    h.act('power-off', 'node-4');
    const w = watch(h, SILENT + 5);
    const at = h.firstAt('redirector.unhealthy', 'node-1');
    expect(at ?? 0).toBeLessThanOrEqual(T + DETECT);
    expect(w.worst).toBeLessThanOrEqual(SILENT + 1);
    expect(h.f('node-1.vm-1', 'ownerCvm')).not.toBe('node-4.cvm');
    expect(vmState(h, 'node-1.vm-1')).toBe('running');
    // SO nodes run no VMs: nothing for HA to restart.
    h.run(P.ahvHa.restartByS.value);
    expect(h.firstAt('ha.vm.restarted')).toBeNull();
  });
});
