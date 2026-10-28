/**
 * Zookeeper ensemble and quorum, Cassandra ring (detach / rejoin), derived cluster status,
 * T3 rules and advisories. Profile timers are read from the current profile.
 */
import { describe, expect, it } from 'vitest';
import { current as P } from '../../../src/domain/versions/profiles/current';
import { harness } from './harness';

const T = 11;
const DETACH = P.cluster.cassandraRingDetachS.value;
const ZK = P.cluster.zkSessionTimeoutS.value;
const MIGRATE = P.cluster.serviceVolumeMigrationDelayS.value;

const members = (h: ReturnType<typeof harness>) => JSON.parse(String(h.d('zkMembers'))) as string[];

describe('Zookeeper ensemble', () => {
  it('3 members under FT1, 5 under FT2 (RF3), on the lowest-id CVM nodes', () => {
    const ft1 = harness('t2-hci-ahv');
    ft1.run(1);
    expect(members(ft1)).toEqual(['node-1.cvm', 'node-2.cvm', 'node-3.cvm']);
    expect(ft1.f('node-4.cvm', 'zkMember')).toBe(false);
    expect(ft1.d('zkLeader')).toBe('node-1.cvm');
    expect(ft1.dev('node-1.cvm').badges).toContain('zk-leader');

    const ft2 = harness('t2-hci-ahv', { 'replication-factor': 3 });
    ft2.run(1);
    expect(members(ft2)).toHaveLength(P.cluster.zkMembersFt2.value);
    expect(ft2.d('ftConfigured')).toBe(2);
    expect(ft2.d('nodeFailureTolerance')).toBe(2);
  });

  it('T3: only CVM-bearing nodes hold seats and count for quorum and FT', () => {
    const h = harness('t3-co-so');
    h.run(5);
    expect(members(h)).toEqual(['node-4.cvm', 'node-5.cvm', 'node-6.cvm']);
    for (const n of [1, 2, 3]) h.act('power-off', `node-${n}`);
    h.run(3);
    expect(h.d('zkQuorum')).toBe(true);
    expect(h.d('nodeFailureTolerance')).toBe(1);
    const rf3 = harness('t3-co-so', { 'replication-factor': 3, 'so-node-count': 5 });
    rf3.run(1);
    expect(rf3.d('ftConfigured')).toBe(2);
    expect(members(rf3)).toEqual([4, 5, 6, 7, 8].map((n) => `node-${n}.cvm`));
  });

  it('a 3/2 partition gives quorum to the majority only (one quorum side)', () => {
    const h = harness('t2-hci-ahv', { 'replication-factor': 3, 'node-count': 5 });
    h.run(10);
    h.act('link-down', 'l-sw-a--sw-b');
    for (const n of [1, 2, 3]) h.act('link-down', `l-node-${n}.eth1--sw-b`);
    for (const n of [4, 5]) h.act('link-down', `l-node-${n}.eth0--sw-a`);
    h.run(1);
    const q = (n: number) => h.f(`node-${n}.cvm`, 'zkQuorum');
    expect([1, 2, 3].map(q)).toEqual([true, true, true]);
    expect([4, 5].map(q)).toEqual([false, false]);
    expect(h.f('node-4.cvm', 'zkPartition')).toBe('node-4.cvm');
    expect(h.f('node-2.cvm', 'zkPartition')).toBe('node-1.cvm');
    expect(h.f('node-4.cvm', 'stargate')).toBe('unhealthy');
    expect(h.d('zkQuorum')).toBe(true);
  });

  it('losing 2 of 3 members loses quorum: services stop after the ZK session timeout', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('power-off', 'node-1.cvm');
    h.act('power-off', 'node-2.cvm');
    h.run(2);
    expect(h.d('zkQuorum')).toBe(false);
    expect(h.d('haStatus')).toBe('Critical');
    expect(h.d('zkLeader')).toBeNull();
    // Services (and Prism Element) last until the ZK session times out.
    expect(h.d('clusterServices')).toBe('up');
    expect(h.d('prismElement')).toBe('up');
    h.run(T + ZK - h.s().simTime);
    expect(h.firstAt('cluster.services.down')).toBe(T + ZK);
    expect(h.d('clusterServices')).toBe('down');
    expect(h.d('prismElement')).toBe('unreachable');
    expect(h.d('prismCentralAlert')).toBe('A200000');
  });

  it('HCI seats are fixed: a lost seat stays lost (A111009 raised)', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('power-off', 'node-1.cvm');
    h.run(MIGRATE + 10);
    expect(members(h)).toEqual(['node-1.cvm', 'node-2.cvm', 'node-3.cvm']);
    expect(h.firstAt('zk.not-active', 'node-1.cvm')).toBe(T);
    expect(h.firstAt('zk.seat.migrated')).toBeNull();
  });

  it('T1: seats move off a lost active node only after serviceVolumeMigrationDelayS', () => {
    const h = harness('t1-ahv-flasharray');
    h.run(10);
    h.act('power-off', 'node-1');
    h.act('power-off', 'node-2');
    h.run(2);
    // Two of three seats lost: no ZK majority until their volumes are mounted elsewhere.
    expect(h.d('zkQuorum')).toBe(false);
    h.run(T + MIGRATE - 1 - h.s().simTime);
    expect(h.firstAt('zk.seat.migrated')).toBeNull();
    expect(h.d('clusterServices')).toBe('down');
    h.run(1);
    expect(h.firstAt('zk.seat.migrated', 'node-4.cvm')).toBe(T + MIGRATE);
    // Only node-4 was inactive: node-2's seat has nowhere to go, 2 of 3 seats are enough.
    expect(members(h)).toEqual(['node-2.cvm', 'node-3.cvm', 'node-4.cvm']);
    h.run(2);
    expect(h.d('zkQuorum')).toBe(true);
    expect(h.d('clusterServices')).toBe('up');
  });

  it('T1: an inactive node failing moves nothing', () => {
    const h = harness('t1-ahv-flasharray');
    h.run(10);
    h.act('power-off', 'node-4');
    h.run(MIGRATE + 10);
    expect(members(h)).toEqual(['node-1.cvm', 'node-2.cvm', 'node-3.cvm']);
    expect(h.d('clusterServices')).toBe('up');
  });
});

describe('Cassandra ring', () => {
  it('detaches a node down for cassandraRingDetachS, not one tick earlier', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('power-off', 'node-2');
    h.run(1);
    expect(h.f('node-2.cvm', 'ringState')).toBe('down');
    // A (cited) wake timer at the detach time lets "fast-forward to next timer" stop there.
    const wake = h.sim.pendingTimers().find((t) => t.name === 'node-2.cvm ring detach');
    expect(wake?.dueAt).toBe(T + DETACH);
    expect(wake?.cite).toEqual(P.cluster.cassandraRingDetachS.cite);
    h.run(DETACH - 1);
    expect(h.f('node-2.cvm', 'ringState')).toBe('down');
    h.run(1);
    expect(h.f('node-2.cvm', 'ringState')).toBe('detached');
    expect(h.firstAt('cassandra.node.detached', 'node-2.cvm')).toBe(T + DETACH);
    expect(h.d('metadataAvailable')).toBe(true);
  });

  it('re-adds the node after it has been stable (assumption), once its CVM is back', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('power-off', 'node-2');
    h.run(DETACH + 5);
    h.act('power-on', 'node-2');
    const up = h.until((s) => s.events.some((e) => e.code === 'stargate.up'), 400);
    expect(up).not.toBeNull();
    if (up === null) return;
    const rejoin = P.cluster.cassandraRejoinStableS.value;
    h.run(rejoin - 1);
    expect(h.f('node-2.cvm', 'ringState')).toBe('detached');
    h.run(2);
    expect(h.f('node-2.cvm', 'ringState')).toBe('normal');
    expect(h.firstAt('cassandra.node.rejoined', 'node-2.cvm')).not.toBeNull();
  });

  it('does not detach below the metadata RF (3 CVM nodes, FT1)', () => {
    const h = harness('t3-co-so', { 'so-node-count': 3 });
    h.run(10);
    h.act('power-off', 'node-6');
    h.run(DETACH + 10);
    expect(h.f('node-6.cvm', 'ringState')).toBe('down');
    expect(h.firstAt('cluster.ft.insufficient-nodes')).toBe(T);
    expect(h.d('nodeFailureTolerance')).toBe(0);
  });

  it('two ring neighbours down on FT1 leaves a range without a Paxos majority', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('power-off', 'node-3');
    h.act('power-off', 'node-4');
    h.run(2);
    expect(h.d('zkQuorum')).toBe(true);
    expect(h.d('metadataAvailable')).toBe(false);
    h.run(ZK);
    expect(h.d('clusterServices')).toBe('down');
  });

  it('T1: metadata lives on the array, so it follows quorum (N−2 failures are fine)', () => {
    // Hades maintenance off, so services come back as soon as the array does.
    const h = harness('t1-ahv-flasharray', { 'hades-maintenance-on-storage-error': 'off' });
    h.run(10);
    h.act('power-off', 'node-3');
    h.act('power-off', 'node-4');
    h.run(2);
    expect(h.d('metadataAvailable')).toBe(true);
    for (const b of h.backends.values()) b.state = 'unavailable';
    h.run(1);
    expect(h.d('metadataAvailable')).toBe(false);
    h.run(ZK);
    expect(h.d('clusterServices')).toBe('down');
    for (const b of h.backends.values()) b.state = 'ok';
    h.run(1);
    expect(h.d('clusterServices')).toBe('up');
    expect(h.firstAt('cluster.services.up')).not.toBeNull();
  });
});

describe('derived status and advisories', () => {
  it('produces every derived key of the view-field contract as a scalar', () => {
    for (const t of ['t1-ahv-flasharray', 't2-hci-ahv', 't3-co-hci'] as const) {
      const h = harness(t);
      h.run(1);
      for (const k of [
        'haStatus',
        'zkQuorum',
        'zkLeader',
        'acropolisLeader',
        'resiliency',
        'nodeFailureTolerance',
        'ftConfigured',
        'metadataAvailable',
        'dataAvailable',
        'underReplicated',
        'clusterServices',
        'blockAwareness',
      ]) {
        const v = h.d(k);
        expect(v === null || typeof v !== 'object', `${t} ${k}`).toBe(true);
        expect(v, `${t} ${k}`).not.toBeUndefined();
      }
    }
  });

  it('block awareness: met for 6 nodes in 3 blocks, not met for 4, off per node', () => {
    const met = harness('t2-hci-ahv', { 'node-count': 6, 'block-layout': 'three-blocks' });
    const not = harness('t2-hci-ahv', { 'block-layout': 'three-blocks' });
    const off = harness('t2-hci-ahv');
    for (const x of [met, not, off]) x.run(1);
    expect([met.d('blockAwareness'), not.d('blockAwareness'), off.d('blockAwareness')]).toEqual([
      'met',
      'not-met',
      'off',
    ]);
  });

  it('CO:HCI ratio advisory only when CO > HCI / 2 (community guidance, unverified)', () => {
    const bad = harness('t3-co-hci', { 'co-node-count': 6, 'hci-node-count': 3 });
    const ok = harness('t3-co-hci');
    bad.run(1);
    ok.run(1);
    const e = bad.events().find((x) => x.code === 'cluster.advisory.co-ratio');
    expect(e?.confidence).toBe('unverified');
    expect(ok.firstAt('cluster.advisory.co-ratio')).toBeNull();
  });

  it('RF3 with fewer than 5 CVM nodes reports cluster.ft.insufficient-nodes at start', () => {
    const h = harness('t3-co-so', { 'replication-factor': 3 });
    h.run(1);
    expect(h.firstAt('cluster.ft.insufficient-nodes')).toBe(1);
  });
});
