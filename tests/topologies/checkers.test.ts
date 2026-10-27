/** The invariant checkers must actually catch violations (guards against vacuous passes). */
import { describe, expect, it } from 'vitest';
import { topologies } from '../../src/topologies';
import type { Topology } from '../../src/topologies/schema';
import {
  conventionProblems,
  faProblems,
  layoutProblems,
  linkProblems,
  reachabilityProblems,
  roleProblems,
} from './invariants';

const t1 = () => structuredClone(topologies['t1-ahv-flasharray']);
const edit = (t: Topology, id: string, patch: Record<string, unknown>): Topology => ({
  ...t,
  devices: t.devices.map((d) => (d.id === id ? ({ ...d, ...patch } as typeof d) : d)),
});

describe('checkers detect violations', () => {
  it('layout: overlap, out-of-parent, missing entry, off-grid', () => {
    const t = t1();
    const vm1 = t.layout['node-1.vm-1'];
    if (vm1) t.layout['node-1.vm-2'] = { ...vm1 };
    t.layout['node-1.eth0'] = { x: 0, y: 10000, w: 60, h: 40 };
    delete t.layout['node-2.cvm'];
    t.layout['sw-a'] = { x: 13, y: 0, w: 240, h: 60 };
    const p = layoutProblems(t).join('\n');
    expect(p).toMatch(/node-1.vm-1 overlaps node-1.vm-2/);
    expect(p).toMatch(/node-1.eth0: outside parent/);
    expect(p).toMatch(/node-2.cvm: no layout entry/);
    expect(p).toMatch(/sw-a: 13 off the 20px grid/);
  });

  it('conventions and links', () => {
    const t = t1();
    const renamed = { ...t, links: t.links.map((l, i) => (i === 0 ? { ...l, id: 'l-bad' } : l)) };
    expect(linkProblems(renamed).join()).toMatch(/expected id/);
    const toCvm = {
      ...t,
      links: [...t.links, { ...t.links[0], id: 'l-x', a: 'node-1.cvm', b: 'sw-a' }],
    };
    expect(linkProblems(toCvm as Topology).join()).toMatch(/not nic\/switch/);
    expect(conventionProblems(edit(t, 'node-1.vs1', { uplinks: ['node-2.eth1'] })).join()).toMatch(
      /not a NIC of node-1/,
    );
  });

  it('roles', () => {
    expect(roleProblems(edit(t1(), 'node-1', { role: 'compute-only' })).join()).toMatch(
      /has a CVM/,
    );
    const t3 = structuredClone(topologies['t3-co-so']);
    expect(roleProblems(edit(t3, 'node-1', { role: 'storage-only' })).join()).toMatch(
      /node-1: storage-only host has 0 CVMs/,
    );
  });

  it('VLAN reachability and FA coverage', () => {
    let t = t1();
    for (const sw of ['sw-a', 'sw-b']) t = edit(t, sw, { vlans: [20, 100, 200] });
    expect(reachabilityProblems(t).join()).toMatch(/node-1.cvm.storage-a: VLAN 10 not carried/);
    const noCt1v20 = { ...t1(), devices: t1().devices.filter((d) => d.id !== 'fa.ct1.eth11.v20') };
    expect(faProblems(noCt1v20)).toEqual(['fa.ct1: no interface on VLAN 20']);
  });
});
