/**
 * Planned maintenance (SPEC §6.2 "Planned maintenance"): the upgrade / LCM path.
 * - `cvm.planned-shutdown`: shutdown token (one CVM at a time), traffic forwarded away, orderly
 *   service stop, power off. The VMs stay on their host and their IO moves to other Stargates after
 *   a brief re-login, unlike an abrupt CVM reboot (ZK expiry + a NOP cycle). `cvm.planned-start`
 *   boots it; sessions fail back after the stability interval.
 * - `host.enter-maintenance` / `host.exit-maintenance`: VMs live-migrate off (brief pause), the host
 *   is unschedulable, and on exit they are migrated back after `ahvHa.maintenanceReturnS`.
 * Times come from the profile.
 */
import { describe, expect, it } from 'vitest';
import { current as P } from '../../../src/domain/versions/profiles/current';
import { type Harness, harness, vmHost, vmState } from './harness';

const PREP = P.cluster.plannedShutdownPrepS.value;
const STALL = P.redirector.redirectStallS.value;
const MIG = P.ahvHa.liveMigrationPauseS.value;
const RET = P.ahvHa.maintenanceReturnS.value;
const ZK = P.hci.stargateDownDetectS.value;
const VM = 'node-2.vm-1';
const CVM = 'node-2.cvm';
const HOST = 'node-2';

/** Run `ticks` ticks; the VM's worst pending IO. */
function worstPending(h: Harness, ticks: number, vm = VM): number {
  let worst = 0;
  for (let i = 0; i < ticks; i++) {
    h.run(1);
    worst = Math.max(worst, Number(h.f(vm, 'ioPendingS')));
  }
  return worst;
}

describe.each(['t1-ahv-flasharray', 't2-hci-ahv'] as const)('planned maintenance (%s)', (topo) => {
  it('a planned CVM shutdown moves IO with only a brief re-login; the VM stays on its host', () => {
    const h = harness(topo);
    h.run(10);
    h.act('cvm.planned-shutdown', CVM);
    h.run(1);
    expect(h.f(CVM, 'plannedShutdown')).toBe('preparing');
    const worst = worstPending(h, PREP + 20);
    expect(h.f(CVM, 'plannedShutdown')).toBe('off');
    expect(h.f(CVM, 'power')).toBe('off');
    expect(h.firstAt('cvm.planned-shutdown.off', CVM)).not.toBeNull();
    expect(worst).toBeLessThanOrEqual(STALL + 2);
    expect(worst).toBeLessThan(ZK);
    expect(vmState(h, VM)).toBe('running');
    expect(vmHost(h, VM)).toBe(HOST);
    expect(h.f(VM, 'ownerCvm')).not.toBe(CVM);
    expect(h.firstAt('redirector.parked', HOST)).toBeNull();
    expect(h.firstAt('vm.crashed')).toBeNull();
    // It stays off (no automatic boot) until a planned start.
    h.run(P.cluster.cvmBootS.value + 10);
    expect(h.f(CVM, 'power')).toBe('off');
  });

  it('an abrupt CVM reboot stalls far longer than a planned shutdown', () => {
    const h = harness(topo);
    h.run(10);
    h.act('reboot', CVM);
    const worst = worstPending(h, ZK + 30);
    expect(worst).toBeGreaterThan(STALL + 2);
  });

  it('the shutdown token allows one planned shutdown at a time', () => {
    const h = harness(topo);
    h.run(10);
    h.act('cvm.planned-shutdown', CVM);
    h.run(1);
    h.act('cvm.planned-shutdown', 'node-3.cvm');
    h.run(1);
    expect(h.events().filter((e) => e.code === 'action.rejected')).toHaveLength(1);
    expect(h.f('node-3.cvm', 'plannedShutdown')).toBe('none');
  });

  it('a planned start boots the CVM, releases the token, and sessions fail back', () => {
    const h = harness(topo);
    h.run(10);
    h.act('cvm.planned-shutdown', CVM);
    h.run(PREP + 10);
    h.act('cvm.planned-start', CVM);
    h.run(P.cluster.cvmBootS.value + 5);
    expect(h.f(CVM, 'stargate')).toBe('up');
    expect(h.f(CVM, 'plannedShutdown')).toBe('none');
    h.run(P.redirector.failbackStableS.value + 30);
    expect(h.f(VM, 'ownerCvm')).toBe(CVM);
    // The token is free again: another CVM may now be shut down.
    h.act('cvm.planned-shutdown', 'node-3.cvm');
    h.run(1);
    expect(h.f('node-3.cvm', 'plannedShutdown')).toBe('preparing');
  });

  it('host maintenance live-migrates the VMs off with a brief pause, and back on exit', () => {
    const h = harness(topo);
    h.run(10);
    h.act('host.enter-maintenance', HOST);
    const worst = worstPending(h, 10);
    expect(h.f(HOST, 'maintenance')).toBe(true);
    expect(vmHost(h, VM)).not.toBe(HOST);
    expect(vmState(h, VM)).toBe('running');
    expect(worst).toBeLessThanOrEqual(MIG + STALL + 2);
    expect(h.firstAt('vm.migrated')).not.toBeNull();
    // The CVM keeps running; nothing is restarted by HA.
    expect(h.f(CVM, 'stargate')).toBe('up');
    expect(h.firstAt('ha.vm.restarted')).toBeNull();
    // The host takes no VMs while in maintenance: a power-on lands elsewhere.
    h.act('host.exit-maintenance', HOST);
    h.run(RET - 5);
    expect(vmHost(h, VM)).not.toBe(HOST);
    const back = worstPending(h, 15);
    expect(vmHost(h, VM)).toBe(HOST);
    expect(vmState(h, VM)).toBe('running');
    expect(back).toBeLessThanOrEqual(MIG + STALL + 2);
    expect(h.firstAt('vm.crashed')).toBeNull();
  });
});
