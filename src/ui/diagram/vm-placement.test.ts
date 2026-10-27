import { describe, expect, it } from 'vitest';
import type { DeviceView } from '../../engine/types';
import { relocateVms } from './vm-placement';

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
  'node-2.vm-1': dev('node-2.vm-1', 'vm', 'node-2', { host: 'node-1' }),
  'node-2.vm-2': dev('node-2.vm-2', 'vm', 'node-2', { host: 'node-1' }),
};
const layout = {
  'node-1.vm-1': { x: 10, y: 40, w: 88, h: 36 },
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
