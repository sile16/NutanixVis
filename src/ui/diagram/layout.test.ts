import { describe, expect, it } from 'vitest';
import type { DeviceView, LinkView } from '../../engine/types';
import { t1Layout } from '../../fixtures/layouts/t1-ahv-flasharray';
import { t1Frames } from '../../fixtures/snapshots/t1-frames';
import { t1Steady } from '../../fixtures/snapshots/t1-steady';
import { computeLayout, exportLayout, facingSide, groupFrame, moveDevice, portKey } from './layout';

const d = (id: string, kind: string, parent?: string): DeviceView => ({
  id,
  kind,
  label: id,
  ...(parent ? { parent } : {}),
  status: 'healthy',
  badges: [],
  fields: {},
});
const link = (id: string, a: string, ap: string, b: string, bp: string): LinkView => ({
  id,
  a: { device: a, port: ap },
  b: { device: b, port: bp },
  status: 'up',
  mtu: 9000,
  latencyMs: 0,
  util: {},
});

describe('computeLayout', () => {
  const devices = {
    h: d('h', 'ahv-host'),
    'h.eth0': d('h.eth0', 'nic', 'h'),
    'h.eth1': d('h.eth1', 'nic', 'h'),
    sw: d('sw', 'switch'),
  };
  const links = {
    l0: link('l0', 'h.eth0', 'p0', 'sw', 'p1'),
    l1: link('l1', 'h.eth1', 'p0', 'sw', 'p2'),
  };
  const layout = {
    'h.eth0': { x: 100, y: 100, w: 50, h: 20 },
    'h.eth1': { x: 200, y: 100, w: 50, h: 20 },
    sw: { x: 0, y: 300, w: 400, h: 50 },
  };

  it('computes group bounds from children + padding + header', () => {
    const r = computeLayout(devices, links, layout);
    const { pad, header } = groupFrame('ahv-host');
    expect(r.placed.get('h')?.rect).toEqual({
      x: 100 - pad,
      y: 100 - pad - header,
      w: 150 + 2 * pad,
      h: 20 + 2 * pad + header,
    });
    expect(r.placed.get('h')?.isGroup).toBe(true);
    expect(r.order.indexOf('h')).toBeLessThan(r.order.indexOf('h.eth0'));
  });

  it('places NIC ports on the side facing the switch and orders switch ports by peer', () => {
    const r = computeLayout(devices, links, layout);
    expect(r.anchors.get(portKey('h.eth0', 'p0'))?.side).toBe('bottom');
    const p1 = r.anchors.get(portKey('sw', 'p1'));
    const p2 = r.anchors.get(portKey('sw', 'p2'));
    expect(p1?.side).toBe('top');
    expect(p2?.side).toBe('top');
    expect((p1?.x ?? 0) < (p2?.x ?? 0)).toBe(true);
    expect(p1?.y).toBe(300);
  });

  it('flows devices that are missing from the layout instead of dropping them', () => {
    const r = computeLayout(
      { ...devices, 'h.eth2': d('h.eth2', 'nic', 'h'), other: d('other', 'switch') },
      links,
      layout,
    );
    const eth2 = r.placed.get('h.eth2')?.rect;
    const host = r.placed.get('h')?.rect;
    expect(eth2).toBeDefined();
    expect(host && eth2 && eth2.y + eth2.h <= host.y + host.h).toBe(true);
    const other = r.placed.get('other')?.rect;
    expect(other && other.y > 350).toBe(true);
  });

  it('lays out the T1 fixture: every device and link end placed, parents enclose children', () => {
    const snap = t1Frames.steady;
    const r = computeLayout(snap.devices, snap.links, t1Layout);
    expect(r.placed.size).toBe(Object.keys(snap.devices).length);
    expect(r.anchors.size).toBe(Object.keys(snap.links).length * 2);
    for (const p of r.placed.values()) {
      if (!p.parent) continue;
      const parent = r.placed.get(p.parent)?.rect;
      expect(parent).toBeDefined();
      if (!parent) continue;
      expect(p.rect.x).toBeGreaterThanOrEqual(parent.x);
      expect(p.rect.y).toBeGreaterThanOrEqual(parent.y);
      expect(p.rect.x + p.rect.w).toBeLessThanOrEqual(parent.x + parent.w);
      expect(p.rect.y + p.rect.h).toBeLessThanOrEqual(parent.y + parent.h);
    }
    expect(r.anchors.get(portKey('sw-a', 'p48'))?.side).toBe('right');
    expect(r.anchors.get(portKey('sw-b', 'p48'))?.side).toBe('left');
    expect(r.anchors.get(portKey('fa.ct0.eth10', 'p0'))?.side).toBe('top');
  });

  it('renders the Phase 0 fixture even though the fixture layout does not cover it fully', () => {
    const r = computeLayout(t1Steady.devices, t1Steady.links, {});
    expect(r.placed.size).toBe(Object.keys(t1Steady.devices).length);
  });
});

describe('facingSide', () => {
  it('prefers vertical exits when the peer is entirely above or below', () => {
    const nic = { x: 1000, y: 150, w: 56, h: 28 };
    const sw = { x: 60, y: 330, w: 620, h: 60 };
    expect(facingSide(nic, sw)).toBe('bottom');
    expect(facingSide(sw, nic)).toBe('top');
    expect(facingSide({ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: 0, w: 10, h: 10 })).toBe('right');
  });
});

describe('layout editing', () => {
  const snap = t1Frames.steady;

  it('moves a leaf and exports rounded absolute positions', () => {
    const r = computeLayout(snap.devices, snap.links, t1Layout);
    const moved = moveDevice(t1Layout, r, snap.devices, 'sw-a', { x: 70.4, y: 340 });
    expect(moved['sw-a']).toMatchObject({ x: 70.4, y: 340 });
    const out = exportLayout(computeLayout(snap.devices, snap.links, moved));
    expect(out['sw-a']).toEqual({ x: 70, y: 340, w: 620, h: 60 });
    expect(out['node-1']).toBeUndefined(); // groups are computed, never exported
  });

  it('moves a group by translating every leaf beneath it', () => {
    const r = computeLayout(snap.devices, snap.links, t1Layout);
    const host = r.placed.get('node-1')?.rect;
    if (!host) throw new Error('node-1 not placed');
    const moved = moveDevice(t1Layout, r, snap.devices, 'node-1', {
      x: host.x + 10,
      y: host.y + 5,
    });
    expect(moved['node-1.eth0']).toMatchObject({
      x: (t1Layout['node-1.eth0']?.x ?? 0) + 10,
      y: (t1Layout['node-1.eth0']?.y ?? 0) + 5,
    });
    expect(moved['node-1.cvm.storage-a']?.x).toBe((t1Layout['node-1.cvm.storage-a']?.x ?? 0) + 10);
    const after = computeLayout(snap.devices, snap.links, moved).placed.get('node-1')?.rect;
    expect(after).toEqual({ ...host, x: host.x + 10, y: host.y + 5 });
  });
});
