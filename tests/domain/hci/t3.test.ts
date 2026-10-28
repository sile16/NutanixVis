import { describe, expect, it } from 'vitest';
import { createHciDomain, MSG } from '../../../src/domain/nutanix/hci';
import { current } from '../../../src/domain/versions/profiles/current';
import { loadSimulation } from '../../../src/loader/simulation';
import { harness } from './fakes';

const T0 = 10;

describe('T3: compute-only + storage-only (SPEC §6.3a)', () => {
  it('only SO CVMs hold data; CO VM IO is served and replicated over the network', () => {
    const h = harness('t3-co-so');
    const s = h.sim.tick(T0);
    const holders = new Set(h.store.extentGroups().flatMap((eg) => eg.replicas.map((r) => r.node)));
    expect([...holders].sort()).toEqual(['node-4.cvm', 'node-5.cvm', 'node-6.cvm', 'node-7.cvm']);
    expect(s.derived.blockAwareness).toBe('off');
    expect(s.derived['hci.rf']).toBe(2);
    expect(h.workload.vms.every((v) => v.host <= 'node-3')).toBe(true);
    expect(h.workload.totals().errors).toBe(0);
    expect(h.workload.maxPendingS(s.simTime)).toBe(0);
    expect(s.traces.some((t) => t.kind === MSG.replicate && t.result === 'delivered')).toBe(true);
  });

  it('T3-01: an SO node fails → rebuild starts, its CO VMs are served elsewhere, data stays up', () => {
    const h = harness('t3-co-so');
    h.sim.tick(T0);
    const affected = h.workload.vms.filter((v) => v.home === 'node-4.cvm');
    expect(affected.length).toBeGreaterThan(0);
    h.sim.applyAction({ kind: 'fail', target: 'node-4' });
    h.sim.tick(current.hci.stargateDownDetectS.value + current.hci.rebuildStartDelayS.value + 1);
    expect(h.events('curator.rebuild.start').map((e) => e.deviceId)).toEqual(['node-4.cvm']);
    for (let i = 0; i < 20; i++) expect(h.sim.tick().derived.dataAvailable).toBe(true);
    for (const v of affected) {
      expect(v.servedBy.at(-1)).not.toBe('node-4.cvm');
      expect(v.errors).toEqual([]);
    }
    expect(h.workload.maxPendingS(h.sim.getSnapshot().simTime)).toBe(0);
  });

  it('a CO node failure loses no data and starts no rebuild', () => {
    const h = harness('t3-co-so');
    h.sim.tick(T0);
    h.sim.applyAction({ kind: 'fail', target: 'node-1' });
    const s = h.sim.tick(5);
    expect(h.events('curator.rebuild.start')).toHaveLength(0);
    expect(s.derived.resiliency).toBe('OK');
  });

  it('t3-co-hci: HCI VMs read locally, CO VMs remotely', () => {
    const h = harness('t3-co-hci');
    h.sim.tick(T0);
    const co = h.workload.vms.filter((v) => v.host === 'node-1' || v.host === 'node-2');
    const hci = h.workload.vms.filter((v) => !co.includes(v));
    expect(co.length).toBeGreaterThan(0);
    expect(hci.every((v) => v.home === `${v.host}.cvm`)).toBe(true);
    expect(co.every((v) => !v.home.startsWith(`${v.host}.`))).toBe(true);
    const s = h.sim.tick();
    // Only CO VMs' reads could ever be remote, and their home Stargate holds a local copy.
    expect(s.traces.filter((t) => t.kind === MSG.read)).toHaveLength(0);
  });
});

describe('loader integration', () => {
  it.each(['t2-hci-ahv', 't3-co-so', 't3-co-hci'] as const)(
    '%s: disk devices and derived fields load without stream F',
    (topologyId) => {
      const { sim, topology } = loadSimulation({
        topologyId,
        domain: ({ topology: t, versions }) => {
          const hci = createHciDomain({ topology: t, profile: versions.profile });
          return { devices: hci.devices, actions: hci.actions ?? [] };
        },
      });
      const s = sim.tick(3);
      for (const d of topology.devices.filter((x) => x.kind === 'disk')) {
        expect(s.devices[d.id]?.fields.state).toBe('online');
        expect(s.devices[d.id]?.fields.offlineEventsLastHour).toBe(0);
      }
      expect(s.derived.resiliency).toBe('OK');
      expect(s.derived.dataAvailable).toBe(true);
      expect(s.derived.underReplicated).toBe(0);
    },
  );
});
