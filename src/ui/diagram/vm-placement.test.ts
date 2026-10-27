import { describe, expect, it } from 'vitest';
import type { DeviceView } from '../../engine/types';
import { relocateFloatingIps, relocateVms } from './vm-placement';

const dev = (
  id: string,
  kind: string,
  parent?: string,
  fields: DeviceView['fields'] = {},
): DeviceView => ({
  id,
  kind,
  label: id,
  ...(parent ? { parent } : {}),
  status: 'healthy',
  badges: [],
  fields,
});

const devices = {
  'node-1': dev('node-1', 'ahv-host'),
  'node-2': dev('node-2', 'ahv-host'),
  'node-1.vm-1': dev('node-1.vm-1', 'vm', 'node-1', { host: 'node-1' }),
  // A NIC on the far side makes node-1 wide enough for two VMs per row.
  'node-1.eth0': dev('node-1.eth0', 'nic', 'node-1'),
  'node-2.vm-1': dev('node-2.vm-1', 'vm', 'node-2', { host: 'node-1' }),
  'node-2.vm-2': dev('node-2.vm-2', 'vm', 'node-2', { host: 'node-1' }),
};
const layout = {
  'node-1.vm-1': { x: 10, y: 40, w: 88, h: 36 },
  'node-1.eth0': { x: 150, y: 200, w: 56, h: 28 },
  'node-2.vm-1': { x: 390, y: 40, w: 88, h: 36 },
  'node-2.vm-2': { x: 482, y: 40, w: 88, h: 36 },
};

describe('relocateVms', () => {
  it('re-parents restarted VMs to their current host, in a row above its own VMs', () => {
    const p = relocateVms(devices, layout);
    expect(p.devices['node-2.vm-1']?.parent).toBe('node-1');
    expect(p.layout['node-2.vm-1']).toEqual({ x: 10, y: 40 - 36 - 8, w: 88, h: 36 });
    expect(p.layout['node-2.vm-2']?.x).toBe(10 + 88 + 8);
    expect(p.moved.get('node-2.vm-2')).toBe('node-1');
  });

  it('remembers where each moved VM came from (restart marker)', () => {
    const p = relocateVms(devices, layout);
    expect(p.movedFrom.get('node-2.vm-1')).toBe('node-2');
    expect(p.movedFrom.has('node-1.vm-1')).toBe(false);
  });

  it('wraps onto a new row instead of growing the host sideways', () => {
    const narrow = { ...layout, 'node-1.eth0': { x: 10, y: 200, w: 56, h: 28 } };
    const p = relocateVms(devices, narrow);
    // Only one 88-wide VM fits across node-1's contents: the second one stacks above the first.
    expect(p.layout['node-2.vm-1']).toEqual({ x: 10, y: 40 - 44, w: 88, h: 36 });
    expect(p.layout['node-2.vm-2']).toEqual({ x: 10, y: 40 - 88, w: 88, h: 36 });
  });

  it('anchors on the host itself when it has no VMs of its own', () => {
    const p = relocateVms(
      {
        'node-1': dev('node-1', 'ahv-host'),
        'node-1.eth0': dev('node-1.eth0', 'nic', 'node-1'),
        'node-2': dev('node-2', 'ahv-host'),
        'node-2.vm-1': dev('node-2.vm-1', 'vm', 'node-2', { host: 'node-1' }),
      },
      {
        'node-1.eth0': { x: 20, y: 300, w: 56, h: 28 },
        'node-2.vm-1': { x: 390, y: 40, w: 88, h: 36 },
      },
    );
    // Inside node-1 (above its NIC), not at its old x in node-2.
    expect(p.layout['node-2.vm-1']).toEqual({ x: 20, y: 300 - 44, w: 88, h: 36 });
  });

  it('leaves VMs on their topology host untouched', () => {
    const p = relocateVms(devices, layout);
    expect(p.devices['node-1.vm-1']).toBe(devices['node-1.vm-1']);
    expect(p.layout['node-1.vm-1']).toEqual(layout['node-1.vm-1']);
  });

  it('ignores crashed VMs with no current host', () => {
    const p = relocateVms(
      { ...devices, 'node-2.vm-1': dev('node-2.vm-1', 'vm', 'node-2', { host: null }) },
      layout,
    );
    expect(p.devices['node-2.vm-1']?.parent).toBe('node-2');
  });
});

describe('relocateFloatingIps', () => {
  const fa = (nic: string) => ({
    fa: dev('fa', 'fa-array'),
    'fa.ct0': dev('fa.ct0', 'fa-controller', 'fa'),
    'fa.ct1': dev('fa.ct1', 'fa-controller', 'fa'),
    'fa.ct0.eth0': dev('fa.ct0.eth0', 'nic', 'fa.ct0'),
    'fa.ct1.eth0': dev('fa.ct1.eth0', 'nic', 'fa.ct1'),
    'fa.ct0.eth0.v100': dev('fa.ct0.eth0.v100', 'fa-interface', 'fa.ct0.eth0'),
    'fa.ct1.eth0.v100': dev('fa.ct1.eth0.v100', 'fa-interface', 'fa.ct1.eth0'),
    'fa.vir0': dev('fa.vir0', 'fa-interface', 'fa', { nic, floating: true }),
  });
  const faLayout = {
    'fa.ct0.eth0.v100': { x: 20, y: 100, w: 66, h: 22 },
    'fa.ct1.eth0.v100': { x: 400, y: 100, w: 66, h: 22 },
    'fa.vir0': { x: 600, y: 60, w: 90, h: 16 },
  };

  it('draws the VIP inside the controller that holds it, below its ports', () => {
    const p = relocateFloatingIps(fa('fa.ct0.eth0'), faLayout);
    expect(p.devices['fa.vir0']?.parent).toBe('fa.ct0');
    expect(p.layout['fa.vir0']).toEqual({ x: 20, y: 122 + 6 + 8, w: 190, h: 16 });
  });

  it('follows the VIP to the new primary after a failover', () => {
    const p = relocateFloatingIps(fa('fa.ct1.eth0'), faLayout);
    expect(p.devices['fa.vir0']?.parent).toBe('fa.ct1');
    expect(p.layout['fa.vir0']?.x).toBe(400);
  });
});
