import { describe, expect, it } from 'vitest';
import type { DeviceView, LinkView } from '../../engine/types';
import { effectiveDevices, effectiveLinkStatus } from './effective-status';

const dev = (
  id: string,
  kind: string,
  parent: string | undefined,
  status: DeviceView['status'] = 'healthy',
  fields: DeviceView['fields'] = {},
): DeviceView => ({
  id,
  kind,
  label: id.toUpperCase(),
  ...(parent ? { parent } : {}),
  status,
  badges: [],
  fields,
});

const link = (a: string, b: string, status: LinkView['status'] = 'up'): LinkView => ({
  id: `l-${a}`,
  a: { device: a, port: 'p0' },
  b: { device: b, port: 'p1' },
  status,
  mtu: 1500,
  latencyMs: 0,
  util: {},
});

describe('effectiveDevices', () => {
  it('draws every descendant of a failed host as failed, with the reason', () => {
    const d = effectiveDevices({
      h: dev('h', 'ahv-host', undefined, 'failed'),
      'h.eth0': dev('h.eth0', 'nic', 'h', 'healthy', { adminUp: true }),
      'h.vs0': dev('h.vs0', 'bond', 'h', 'offline'),
      'h.cvm': dev('h.cvm', 'cvm', 'h', 'offline'),
      'h.cvm.mgmt': dev('h.cvm.mgmt', 'cvm-interface', 'h.cvm'),
    });
    for (const id of ['h.eth0', 'h.vs0', 'h.cvm', 'h.cvm.mgmt']) {
      expect(d[id]?.status, id).toBe('failed');
      expect(d[id]?.downReason, id).toBe('H failed');
    }
  });

  it('honors the engine contract fields down / downReason', () => {
    const d = effectiveDevices({
      n: dev('n', 'nic', undefined, 'healthy', { down: true, downReason: 'node-4 failed' }),
    });
    expect(d.n?.status).toBe('failed');
    expect(d.n?.downReason).toBe('node-4 failed');
  });

  it('draws healthy children of a powered-off device as offline, and leaves others alone', () => {
    const d = effectiveDevices({
      h: dev('h', 'ahv-host', undefined, 'offline'),
      'h.eth0': dev('h.eth0', 'nic', 'h'),
      x: dev('x', 'ahv-host', undefined),
      'x.eth0': dev('x.eth0', 'nic', 'x'),
    });
    expect(d['h.eth0']?.status).toBe('offline');
    expect(d['x.eth0']).toBeDefined();
    expect(d['x.eth0']?.status).toBe('healthy');
    expect(d['x.eth0']?.downReason).toBeUndefined();
  });

  it('judges a restarted VM by the host it runs on now, not its topology host', () => {
    const d = effectiveDevices({
      'node-4': dev('node-4', 'ahv-host', undefined, 'failed'),
      'node-1': dev('node-1', 'ahv-host', undefined),
      'node-4.vm-1': dev('node-4.vm-1', 'vm', 'node-4', 'healthy', { host: 'node-1' }),
    });
    expect(d['node-4.vm-1']?.status).toBe('healthy');
  });
});

describe('effectiveLinkStatus', () => {
  it('is down when either end is drawn failed or offline', () => {
    const d = effectiveDevices({
      h: dev('h', 'ahv-host', undefined, 'failed'),
      'h.eth0': dev('h.eth0', 'nic', 'h'),
      sw: dev('sw', 'switch', undefined),
    });
    expect(effectiveLinkStatus(link('h.eth0', 'sw'), d)).toBe('down');
    expect(effectiveLinkStatus(link('sw', 'sw'), d)).toBe('up');
    expect(effectiveLinkStatus(link('sw', 'sw', 'down'), d)).toBe('down');
  });
});
