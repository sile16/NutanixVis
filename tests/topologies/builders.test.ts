import { describe, expect, it } from 'vitest';
import {
  buildT1,
  buildT1Lab,
  buildT2,
  buildT3CoHci,
  buildT3CoSo,
  diffTopologies,
  layoutJson,
  optionPatch,
  topologies,
} from '../../src/topologies';
import type { DeviceSpec, Topology } from '../../src/topologies/schema';
import { type Dev, index, ofKind, reachabilityProblems, switchesReaching } from './invariants';

const get = <K extends DeviceSpec['kind']>(t: Topology, id: string, kind: K): Dev<K> => {
  const d = index(t).get(id);
  if (d?.kind !== kind) throw new Error(`${id} is not a ${kind}`);
  return d as Dev<K>;
};
const roles = (t: Topology) => ofKind(t, 'ahv-host').map((h) => h.role);
const count = (t: Topology, kind: DeviceSpec['kind']) => ofKind(t, kind).length;

describe('t1-ahv-flasharray', () => {
  const t = topologies['t1-ahv-flasharray'];

  it('default shape: 4 nodes × (4 NICs, vs0+vs1, CVM with 3 ifaces, 2 VMs), FA with 2 CTs', () => {
    expect(count(t, 'ahv-host')).toBe(4);
    expect(new Set(roles(t))).toEqual(new Set(['external-storage-compute']));
    expect(count(t, 'cvm')).toBe(4);
    expect(count(t, 'vm')).toBe(8);
    expect(count(t, 'cvm-interface')).toBe(12);
    expect(count(t, 'fa-controller')).toBe(2);
    const vs0 = get(t, 'node-1.vs0', 'vswitch');
    const vs1 = get(t, 'node-1.vs1', 'vswitch');
    expect(vs0).toMatchObject({
      bondMode: 'active-backup',
      uplinks: ['node-1.eth0', 'node-1.eth2'],
    });
    expect(vs1).toMatchObject({ bondMode: 'balance-slb', uplinks: ['node-1.eth1', 'node-1.eth3'] });
    expect(t.links.map((l) => l.id)).toEqual(
      expect.arrayContaining([
        'l-node-1.eth1--sw-a',
        'l-node-1.eth3--sw-b',
        'l-fa.ct0.eth10--sw-a',
        'l-fa.ct1.eth11--sw-b',
        'l-sw-a--sw-b',
      ]),
    );
    const ifaces = ofKind(t, 'cvm-interface').filter((i) => i.parent === 'node-1.cvm');
    expect(ifaces.map((i) => [i.id, i.vswitch, i.vlan])).toEqual([
      ['node-1.cvm.mgmt', 'node-1.vs0', 100],
      ['node-1.cvm.storage-a', 'node-1.vs1', 10],
      ['node-1.cvm.storage-b', 'node-1.vs1', 20],
    ]);
    // Default is isolated storage VLANs (fabric A/B): VLAN 10 only on sw-a, VLAN 20 only on sw-b.
    expect(get(t, 'sw-a', 'switch').vlans).toEqual([10, 100, 200]);
    expect(get(t, 'sw-b', 'switch').vlans).toEqual([20, 100, 200]);
    expect(get(t, 'sw-a', 'switch').flowControl).toBe('off');
    const both = buildT1({ vlanPlacement: 'tagged-both' });
    for (const sw of ['sw-a', 'sw-b'])
      expect(get(both, sw, 'switch').vlans).toEqual([10, 20, 100, 200]);
    expect(ofKind(t, 'fa-interface').map((i) => i.id)).toEqual(
      expect.arrayContaining(['fa.ct0.eth10.v10', 'fa.ct0.eth11.v20', 'fa.ct1.eth10.v10']),
    );
  });

  it.each([3, 5, 8] as const)('nodeCount %i', (n) => {
    expect(count(buildT1({ nodeCount: n }), 'ahv-host')).toBe(n);
  });

  it('strict A/B: storage-a only on Switch A, storage-b only on B, ISL carries neither', () => {
    const s = buildT1({ vlanPlacement: 'strict-ab' });
    expect(get(s, 'sw-a', 'switch').vlans).toEqual([10, 100, 200]);
    expect(get(s, 'sw-b', 'switch').vlans).toEqual([20, 100, 200]);
    // eth3 (Switch B) alone can no longer reach VLAN 10.
    expect(switchesReaching(s, ['node-1.eth3'], 10).size).toBe(0);
    expect(reachabilityProblems(s)).toEqual([]);
  });

  it('single storage VLAN: one CVM storage vNIC, all FA data IPs on VLAN 10', () => {
    const s = buildT1({ storageVlans: 'single' });
    expect(s.vlans.map((v) => v.id)).toEqual([10, 100, 200]);
    expect(ofKind(s, 'cvm-interface').some((i) => i.id.endsWith('storage-b'))).toBe(false);
    const data = ofKind(s, 'fa-interface').filter((i) => i.service === 'nvme-tcp');
    expect(new Set(data.map((i) => i.vlan))).toEqual(new Set([10]));
    expect(data).toHaveLength(4);
  });

  it('MTU mismatch: switches at 1500 while vs1 and FA ports stay 9000', () => {
    const s = buildT1({ mtu: '1500-mismatch' });
    expect(get(s, 'sw-a', 'switch').mtu).toBe(1500);
    expect(get(s, 'node-1.vs1', 'vswitch').mtu).toBe(9000);
    expect(get(s, 'fa.ct0.eth10', 'nic').mtu).toBe(9000);
    expect(get(t, 'sw-a', 'switch').mtu).toBe(9216);
  });

  it('bond modes, LACP rate and MLAG map onto vs1 and the switches', () => {
    const lacp = buildT1({ vs1BondMode: 'balance-tcp', lacpRate: 'slow', mlag: true });
    expect(get(lacp, 'node-2.vs1', 'vswitch')).toMatchObject({
      bondMode: 'balance-tcp',
      lacpRate: 'slow',
    });
    expect(get(lacp, 'sw-a', 'switch').mlagDomain).toBe('mlag-1');
    expect(get(lacp, 'sw-b', 'switch').mlagDomain).toBe('mlag-1');
    expect(get(t, 'sw-a', 'switch').mlagDomain).toBeUndefined();
    expect(get(t, 'node-1.vs1', 'vswitch').lacpRate).toBeUndefined();
    const nb = buildT1({ vs1BondMode: 'no-bond' });
    expect(get(nb, 'node-1.vs1', 'vswitch').uplinks).toEqual(['node-1.eth1']);
    // eth3 stays cabled so set-uplinks can re-add it at runtime.
    expect(nb.links.some((l) => l.a === 'node-1.eth3')).toBe(true);
  });

  it('option patch for a runtime change touches only the expected fields', () => {
    const { diff } = optionPatch('t1-ahv-flasharray', t, 'vs1-bond-mode', 'active-backup');
    expect(Object.keys(diff.devices.changed).every((id) => id.endsWith('.vs1'))).toBe(true);
    expect(Object.keys(diff.devices.changed)).toHaveLength(4);
    expect(diffTopologies(t, buildT1()).isEmpty).toBe(true);
  });
});

describe('t1-lab', () => {
  const t = topologies['t1-lab'];
  it('single NIC, no bond, all CVM segments on vs0, two FA IPs per data port', () => {
    expect(count(t, 'ahv-host')).toBe(3);
    expect(count(t, 'vswitch')).toBe(3);
    for (const h of ofKind(t, 'ahv-host')) {
      const nics = ofKind(t, 'nic').filter((n) => n.parent === h.id);
      expect(nics.map((n) => n.id)).toEqual([`${h.id}.eth0`]);
      expect(get(t, `${h.id}.vs0`, 'vswitch')).toMatchObject({
        bondMode: 'no-bond',
        uplinks: [`${h.id}.eth0`],
      });
    }
    expect(new Set(ofKind(t, 'cvm-interface').map((i) => i.vswitch.split('.')[1]))).toEqual(
      new Set(['vs0']),
    );
    const perPort = new Map<string, number>();
    for (const i of ofKind(t, 'fa-interface').filter((x) => x.service === 'nvme-tcp')) {
      perPort.set(i.nic, (perPort.get(i.nic) ?? 0) + 1);
    }
    expect([...perPort.values()]).toEqual([2, 2, 2, 2]);
  });
  it('nodeCount param', () => {
    expect(count(buildT1Lab({ nodeCount: 6 }), 'ahv-host')).toBe(6);
  });
});

describe('t2-hci-ahv', () => {
  const t = topologies['t2-hci-ahv'];
  it('4 HCI nodes, 2 NVMe + 4 SSD each, active-backup vs0 on eth0 (A) + eth1 (B)', () => {
    expect(roles(t)).toEqual(['hci', 'hci', 'hci', 'hci']);
    const disks = ofKind(t, 'disk').filter((d) => d.parent === 'node-1');
    expect(disks.map((d) => d.media)).toEqual(['nvme', 'nvme', 'ssd', 'ssd', 'ssd', 'ssd']);
    expect(get(t, 'node-1.vs0', 'vswitch')).toMatchObject({
      bondMode: 'active-backup',
      uplinks: ['node-1.eth0', 'node-1.eth1'],
    });
    expect(get(t, 'node-1.eth0', 'nic').speedGbps).toBe(25);
    expect(t.links.map((l) => l.id)).toEqual(
      expect.arrayContaining(['l-node-1.eth0--sw-a', 'l-node-1.eth1--sw-b', 'l-sw-a--sw-b']),
    );
    expect(count(t, 'fa-array')).toBe(0);
  });
  it('RF3 variant defaults to 5 nodes and refuses fewer', () => {
    const rf3 = buildT2({ replicationFactor: 3 });
    expect(count(rf3, 'ahv-host')).toBe(5);
    expect(rf3.options.find((o) => o.id === 'replication-factor')?.value).toBe(3);
    expect(() => buildT2({ replicationFactor: 3, nodeCount: 4 })).toThrow(/5 nodes/);
  });
  it('block layouts', () => {
    const blocks = (x: Topology) => ofKind(x, 'ahv-host').map((h) => h.block);
    expect(blocks(t)).toEqual(['block-1', 'block-2', 'block-3', 'block-4']);
    expect(blocks(buildT2({ blockLayout: 'shared-chassis' }))).toEqual(Array(4).fill('block-1'));
    expect(blocks(buildT2({ blockLayout: 'three-blocks', nodeCount: 6 }))).toEqual([
      'block-1',
      'block-2',
      'block-3',
      'block-1',
      'block-2',
      'block-3',
    ]);
  });
  it('backplane segmentation adds a backplane vNIC per CVM on VLAN 30', () => {
    const s = buildT2({ backplane: true });
    const bp = ofKind(s, 'cvm-interface').filter((i) => i.service === 'backplane');
    expect(bp.map((i) => i.id)).toEqual([1, 2, 3, 4].map((n) => `node-${n}.cvm.backplane`));
    expect(get(s, 'sw-a', 'switch').vlans).toContain(30);
    expect(reachabilityProblems(s)).toEqual([]);
  });
  it('bond mode param', () => {
    expect(get(buildT2({ vs0BondMode: 'balance-slb' }), 'node-3.vs0', 'vswitch').bondMode).toBe(
      'balance-slb',
    );
  });
});

describe('t3', () => {
  it('co-so: 3 CO (no CVM/disks) + 4 SO (CVM + disks, no VMs)', () => {
    const t = topologies['t3-co-so'];
    expect(roles(t)).toEqual([
      'compute-only',
      'compute-only',
      'compute-only',
      'storage-only',
      'storage-only',
      'storage-only',
      'storage-only',
    ]);
    expect(count(t, 'cvm')).toBe(4);
    expect(count(t, 'vm')).toBe(6);
    expect(ofKind(t, 'vm').every((v) => Number(v.parent?.slice(5)) <= 3)).toBe(true);
    expect(t.options.find((o) => o.id === 'vs0-bond-mode')?.runtime).toBe(true);
  });
  it('co-hci: 2 CO + 4 HCI', () => {
    const t = topologies['t3-co-hci'];
    expect(roles(t)).toEqual(['compute-only', 'compute-only', 'hci', 'hci', 'hci', 'hci']);
    expect(count(t, 'vm')).toBe(12);
  });
  it('count params', () => {
    expect(
      roles(buildT3CoSo({ coCount: 4, storageCount: 3 })).filter((r) => r === 'compute-only'),
    ).toHaveLength(4);
    expect(count(buildT3CoHci({ coCount: 1, storageCount: 6 }), 'cvm')).toBe(6);
    expect(() => buildT3CoSo({ coCount: 2 as 3 })).toThrow();
  });
});

describe('layout', () => {
  it('hosts on top, switches in the middle, FA at the bottom', () => {
    const t = topologies['t1-ahv-flasharray'];
    const L = t.layout;
    const hostBottom = Math.max(
      ...ofKind(t, 'ahv-host').map((h) => (L[h.id]?.y ?? 0) + (L[h.id]?.h ?? 0)),
    );
    expect(L['sw-a']?.y).toBeGreaterThan(hostBottom);
    expect(L.fa?.y).toBeGreaterThan((L['sw-a']?.y ?? 0) + (L['sw-a']?.h ?? 0));
    expect(L['sw-a']?.x).toBeLessThan(L['sw-b']?.x ?? 0);
    // Host NICs sit on the host's bottom edge; FA ports on the controller's top edge.
    expect((L['node-1.eth1']?.y ?? 0) + (L['node-1.eth1']?.h ?? 0)).toBe(L['node-1']?.h);
    expect(L['fa.ct0.eth10']?.y).toBe(0);
  });
  it('layoutJson is sorted and round-trips', () => {
    const t = topologies['t2-hci-ahv'];
    const json = layoutJson(t.layout);
    const keys = Object.keys(JSON.parse(json) as Record<string, unknown>);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
    expect(JSON.parse(json)).toEqual(t.layout);
  });
});
