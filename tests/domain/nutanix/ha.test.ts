/**
 * AHV HA (Bible 5b; AHV Admin Guide 11.2): T+timeoutStartS disconnected, T+fenceAtS fenced,
 * restart by T+restartByS; leader re-election at +leaderReelectionS; isolated VMs self-terminate
 * isolatedVmSelfTerminateS after their first failed IO. T1 rules from DEPLOY-GUIDE. Each timer
 * is checked at its boundary (fires at T, not at T−1). T is the tick the failure applies.
 */
import { describe, expect, it } from 'vitest';
import { current as P } from '../../../src/domain/versions/profiles/current';
import { harness, instances, vmHost, vmIds, vmState } from './harness';

const HA = P.ahvHa;
/** Actions queued at t=10 apply at T=11. */
const T = 11;

function powerLoss(topology: Parameters<typeof harness>[0], host: string) {
  const h = harness(topology);
  h.run(10);
  h.act('power-off', host);
  return h;
}

describe('host power loss timeline (T2)', () => {
  it('disconnected at T+20, fenced at T+60, restarted at T+120 — each not one tick earlier', () => {
    const h = powerLoss('t2-hci-ahv', 'node-2');
    const runTo = (t: number) => h.run(t - h.s().simTime);

    runTo(T + HA.timeoutStartS.value - 1);
    expect(h.f('node-2', 'haState')).toBe('connected');
    runTo(T + HA.timeoutStartS.value);
    expect(h.f('node-2', 'haState')).toBe('disconnected');
    expect(h.firstAt('ha.host.disconnected', 'node-2')).toBe(T + HA.timeoutStartS.value);

    runTo(T + HA.fenceAtS.value - 1);
    expect(h.f('node-2', 'haState')).toBe('disconnected');
    expect(h.cluster.isHostFenced('node-2')).toBe(false);
    runTo(T + HA.fenceAtS.value);
    expect(h.f('node-2', 'haState')).toBe('fenced');
    expect(h.cluster.isHostFenced('node-2')).toBe(true);
    expect(h.d('haStatus')).toBe('Healing');
    expect(vmState(h, 'node-2.vm-1')).toBe('restarting');

    runTo(T + HA.restartByS.value - 1);
    expect(vmState(h, 'node-2.vm-1')).toBe('restarting');
    runTo(T + HA.restartByS.value);
    for (const v of ['node-2.vm-1', 'node-2.vm-2']) {
      expect(vmState(h, v)).toBe('running');
      expect(vmHost(h, v)).not.toBe('node-2');
      expect(h.firstAt('ha.vm.restarted', v)).toBe(T + HA.restartByS.value);
    }
    h.run(1);
    expect(h.d('haStatus')).toBe('OK');
  });

  it('VMs are crashed (not running anywhere) until the restart', () => {
    const h = powerLoss('t2-hci-ahv', 'node-2');
    h.run(1);
    expect(vmState(h, 'node-2.vm-1')).toBe('crashed');
    expect(instances(h, 'node-2.vm-1')).toEqual([]);
    expect(vmHost(h, 'node-2.vm-1')).toBeNull();
  });

  it('restart targets are least loaded, then lowest id; storage-only nodes are never used', () => {
    const h = powerLoss('t3-co-so', 'node-1');
    h.run(HA.restartByS.value + 2);
    const hosts = ['node-1.vm-1', 'node-1.vm-2'].map((v) => vmHost(h, v));
    expect(hosts).toEqual(['node-2', 'node-3']);
  });

  it('the host coming back reconnects it and lifts the fence', () => {
    const h = powerLoss('t2-hci-ahv', 'node-2');
    h.run(HA.fenceAtS.value + 5);
    h.act('power-on', 'node-2');
    h.run(3);
    expect(h.f('node-2', 'haState')).toBe('connected');
    expect(h.cluster.isHostFenced('node-2')).toBe(false);
    expect(h.firstAt('ha.host.connected', 'node-2')).not.toBeNull();
  });
});

describe('Acropolis leader', () => {
  it('starts on the lowest node id (SPEC §14 #8) and carries the badge', () => {
    const h = harness('t2-hci-ahv');
    h.run(1);
    expect(h.d('acropolisLeader')).toBe('node-1');
    expect(h.dev('node-1').badges).toContain('acropolis-leader');
    // T3: the lowest node with a CVM (CO nodes cannot run Acropolis).
    const t3 = harness('t3-co-hci');
    t3.run(1);
    expect(t3.d('acropolisLeader')).toBe('node-3');
  });

  it('is re-elected leaderReelectionS after its host is lost; the HA timeline is unchanged', () => {
    const h = powerLoss('t2-hci-ahv', 'node-1');
    h.run(1);
    expect(h.d('acropolisLeader')).toBeNull();
    h.run(HA.leaderReelectionS.value - 1);
    expect(h.d('acropolisLeader')).toBeNull();
    h.run(1);
    expect(h.d('acropolisLeader')).toBe('node-2');
    expect(h.firstAt('ha.leader.elected', 'node-2')).toBe(T + HA.leaderReelectionS.value);
    h.run(HA.restartByS.value);
    expect(h.firstAt('ha.host.fenced', 'node-1')).toBe(T + HA.fenceAtS.value);
    expect(h.firstAt('ha.vm.restarted', 'node-1.vm-1')).toBe(T + HA.restartByS.value);
  });
});

describe('host isolation (T2)', () => {
  it('isolated VMs self-terminate 45 s after their first failed IO, before the fence', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('host.isolate', 'node-2');
    h.run(3);
    expect(h.f('node-2.cvm', 'zkQuorum')).toBe(false);
    expect(Number(h.f('node-2.vm-1', 'writePendingS'))).toBeGreaterThan(0);
    // Reads are still served by the local Stargate over virbr0.
    expect(Number(h.f('node-2.vm-1', 'readPendingS'))).toBe(0);
    // Minority writes are refused from T+1 (quorum loss seen at the end of T).
    const firstFail = T + 1;
    const due = firstFail + HA.isolatedVmSelfTerminateS.value;
    h.run(due - 1 - h.s().simTime);
    expect(h.firstAt('ha.vm.self-terminated')).toBeNull();
    h.run(1);
    expect(h.firstAt('ha.vm.self-terminated', 'node-2.vm-1')).toBe(due);
    expect(due).toBeLessThan(T + HA.fenceAtS.value);
    h.run(T + HA.restartByS.value - h.s().simTime);
    expect(vmHost(h, 'node-2.vm-1')).not.toBe('node-2');
    expect(vmState(h, 'node-2.vm-1')).toBe('running');
  });

  it('host.isolate drops every host uplink; host.unisolate restores them', () => {
    const h = harness('t2-hci-ahv');
    h.run(5);
    h.act('host.isolate', 'node-3');
    h.run(1);
    for (const l of ['l-node-3.eth0--sw-a', 'l-node-3.eth1--sw-b']) {
      expect(h.s().links[l]?.status).toBe('down');
    }
    expect(h.f('node-3', 'isolated')).toBe(true);
    h.act('host.unisolate', 'node-3');
    h.run(1);
    expect(h.s().links['l-node-3.eth0--sw-a']?.status).toBe('up');
  });
});

describe('T1 rules (DEPLOY-GUIDE "Compute Cluster High Availability")', () => {
  it.each([
    [3, 1],
    [4, 2],
    [5, 2],
    [6, 3],
  ])('%i nodes tolerate %i simultaneous failures (N−2 below 5, N−3 at 5+)', (n, tol) => {
    const h = harness('t1-ahv-flasharray', { 'node-count': n });
    h.run(2);
    expect(h.d('nodeFailureTolerance')).toBe(tol);
  });

  it('tolerance drops per node lost; services resume on survivors up to N−2', () => {
    const h = harness('t1-ahv-flasharray');
    h.run(10);
    h.act('power-off', 'node-1');
    h.act('power-off', 'node-2');
    h.run(2);
    expect(h.d('nodeFailureTolerance')).toBe(0);
    expect(h.d('zkQuorum')).toBe(true);
    expect(h.d('clusterServices')).toBe('up');
    h.run(HA.restartByS.value + 2);
    for (const v of ['node-1.vm-1', 'node-2.vm-2']) {
      expect(['node-3', 'node-4']).toContain(vmHost(h, v));
    }
  });

  it('with no fabric anywhere there is no majority: no fence, no restart, VMs stall then resume', () => {
    const h = harness('t1-ahv-flasharray');
    h.run(10);
    h.act('fail', 'sw-a');
    h.act('fail', 'sw-b');
    for (const b of h.backends.values()) b.state = 'unavailable';
    h.run(HA.restartByS.value + 20);
    expect(h.d('zkQuorum')).toBe(false);
    expect(h.d('clusterServices')).toBe('down');
    expect(h.firstAt('ha.host.fenced')).toBeNull();
    expect(h.firstAt('ha.vm.restarted')).toBeNull();
    expect(h.firstAt('ha.vm.self-terminated')).toBeNull();
    for (const v of vmIds(h)) expect(vmState(h, v)).toBe('io-stalled');
    h.act('recover', 'sw-a');
    h.act('recover', 'sw-b');
    for (const b of h.backends.values()) b.state = 'ok';
    h.run(HA.leaderReelectionS.value + 5);
    expect(h.d('clusterServices')).toBe('up');
    for (const v of vmIds(h)) {
      expect(vmState(h, v)).toBe('running');
      expect(vmHost(h, v)).toBe(v.split('.')[0]);
    }
  });

  it('a CVM that lost every array path keeps its Stargate up and its VMs stall in place', () => {
    const h = harness('t1-ahv-flasharray');
    h.run(10);
    const b = h.backends.get('node-1.cvm');
    if (b) b.state = 'unavailable';
    h.run(120);
    expect(h.f('node-1.cvm', 'stargate')).toBe('up');
    expect(h.f('node-1', 'haState')).toBe('connected');
    expect(vmState(h, 'node-1.vm-1')).toBe('io-stalled');
    expect(h.f('node-1.vm-1', 'ownerCvm')).toBe('node-1.cvm');
    expect(h.firstAt('vm.force-shutdown')).toBeNull();
    expect(h.firstAt('vm.io.guest-timeout', 'node-1.vm-1')).toBe(
      T + P.guest.linuxScsiTimeoutS.value + 1,
    );
    if (b) b.state = 'ok';
    h.run(2);
    expect(vmState(h, 'node-1.vm-1')).toBe('running');
  });

  it('per-VM force-shutdown fires at the timeout (from the first stuck IO), then HA restarts it', () => {
    const limit = 60;
    const h = harness('t1-lab', { 'path-loss-force-shutdown-s': limit });
    h.run(10);
    const b = h.backends.get('node-1.cvm');
    if (b) b.state = 'unavailable';
    // First IO that cannot complete is issued at T.
    h.run(T + limit - 1 - h.s().simTime);
    expect(h.firstAt('vm.force-shutdown')).toBeNull();
    h.run(1);
    expect(h.firstAt('vm.force-shutdown', 'node-1.vm-1')).toBe(T + limit);
    expect(vmState(h, 'node-1.vm-1')).toBe('off');
    h.run(HA.heartbeatIntervalS.value);
    expect(vmState(h, 'node-1.vm-1')).toBe('running');
    expect(vmHost(h, 'node-1.vm-1')).not.toBe('node-1');
    expect(h.firstAt('ha.vm.restarted', 'node-1.vm-1')).toBe(T + limit + 1);
  });

  it('vm.set-path-loss-force-shutdown sets and clears the per-VM timeout', () => {
    const h = harness('t1-ahv-flasharray');
    h.act('vm.set-path-loss-force-shutdown', 'node-1.vm-1', { seconds: 120 });
    h.run(1);
    expect(h.f('node-1.vm-1', 'pathLossForceShutdownS')).toBe(120);
    h.act('vm.set-path-loss-force-shutdown', 'node-1.vm-1', { seconds: 'off' });
    h.run(1);
    expect(h.f('node-1.vm-1', 'pathLossForceShutdownS')).toBeNull();
  });
});

describe('host and VM power actions', () => {
  it('reboot: VMs crash, HA restarts them, the host and its CVM come back', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('reboot', 'node-3');
    h.run(1);
    expect(h.f('node-3', 'power')).toBe('off');
    expect(vmState(h, 'node-3.vm-1')).toBe('crashed');
    expect(h.f('node-3.cvm', 'state')).toBe('down');
    h.run(HA.restartByS.value);
    expect(vmHost(h, 'node-3.vm-1')).not.toBe('node-3');
    h.run(400);
    expect(h.f('node-3', 'power')).toBe('on');
    expect(h.f('node-3.cvm', 'stargate')).toBe('up');
  });

  it('VM power-off is not restarted by HA; power-on starts it on its host', () => {
    const h = harness('t2-hci-ahv');
    h.run(5);
    h.act('power-off', 'node-1.vm-1');
    h.run(HA.restartByS.value + 5);
    expect(vmState(h, 'node-1.vm-1')).toBe('off');
    h.act('power-on', 'node-1.vm-1');
    h.run(1);
    expect(vmState(h, 'node-1.vm-1')).toBe('running');
    expect(vmHost(h, 'node-1.vm-1')).toBe('node-1');
  });

  it('only applicable actions are offered', () => {
    const h = harness('t2-hci-ahv');
    const kinds = (id: string) => h.sim.availableActions(id).map((a) => a.kind);
    expect(kinds('node-1')).toEqual(
      expect.arrayContaining(['power-off', 'reboot', 'host.isolate']),
    );
    expect(kinds('node-1')).not.toContain('cvm.stop-stargate');
    expect(kinds('node-1.cvm')).toEqual(expect.arrayContaining(['cvm.stop-stargate', 'reboot']));
    expect(kinds('node-1.vm-1')).toContain('power-off');
    expect(kinds('node-1.vm-1')).not.toContain('vm.set-path-loss-force-shutdown');
  });
});
