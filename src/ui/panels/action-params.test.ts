import { describe, expect, it } from 'vitest';
import type { ActionSpec, DeviceView, LinkView, SimEvent } from '../../engine/types';
import { currentChoice, initialParams, rejectionReason } from './action-params';

const spec = (kind: string, key: string, choices: (string | number)[]): ActionSpec => ({
  kind,
  label: kind,
  appliesTo: () => true,
  params: { [key]: { label: key, choices } },
});
const device = (fields: DeviceView['fields']): DeviceView => ({
  id: 'd',
  kind: 'bond',
  label: 'd',
  status: 'healthy',
  badges: [],
  fields,
});
const link: LinkView = {
  id: 'l',
  a: { device: 'a', port: 'p' },
  b: { device: 'b', port: 'p' },
  status: 'up',
  mtu: 1500,
  latencyMs: 5,
  util: {},
};

describe('action params', () => {
  it('pre-selects the current state for each known parameter', () => {
    const mode = spec('vswitch.set-bond-mode', 'mode', ['active-backup', 'balance-slb']);
    expect(initialParams(mode, device({ bondMode: 'balance-slb' }))).toEqual({
      mode: 'balance-slb',
    });
    const vlanAware = spec('vswitch.set-slb-vlan-aware', 'enabled', ['on', 'off']);
    expect(currentChoice(vlanAware, 'enabled', device({ slbVlanAware: false }))).toBe('off');
    const mlag = spec('fabric.set-mlag', 'enabled', ['on', 'off']);
    expect(currentChoice(mlag, 'enabled', device({ mlagDomain: null }))).toBe('off');
    expect(currentChoice(mlag, 'enabled', device({ mlagDomain: 'pod-1' }))).toBe('on');
    const latency = spec('set-latency', 'ms', [0, 1, 5]);
    expect(currentChoice(latency, 'ms', link)).toBe(5);
    const fs = spec('vm.set-path-loss-force-shutdown', 'seconds', ['off', 60]);
    expect(currentChoice(fs, 'seconds', device({ pathLossForceShutdownS: null }))).toBe('off');
    expect(currentChoice(fs, 'seconds', device({ pathLossForceShutdownS: 60 }))).toBe(60);
  });

  it('falls back to the first choice when the state is unknown', () => {
    expect(initialParams(spec('x', 'usedPct', [10, 20]), device({}))).toEqual({ usedPct: 10 });
  });

  it('finds the engine rejection for this action and target since it was applied', () => {
    const ev = (t: number, code: string, text: string): SimEvent => ({
      seq: t,
      t,
      severity: 'warn',
      code,
      text,
      causeIds: [],
      cite: [],
    });
    const log = [
      ev(3, 'action.rejected', 'fabric.set-mlag on sw-a: old'),
      ev(5, 'action.fabric.set-mlag', 'Set MLAG: sw-a'),
      ev(5, 'action.rejected', 'fabric.set-mlag on sw-a: switch sw-a has no MLAG domain'),
    ];
    expect(rejectionReason(log, 'fabric.set-mlag', 'sw-a', 5)).toBe(
      'switch sw-a has no MLAG domain',
    );
    expect(rejectionReason(log, 'fabric.set-mlag', 'sw-b', 5)).toBeNull();
    expect(rejectionReason(log, 'fabric.set-mlag', 'sw-a', 6)).toBeNull();
  });
});
