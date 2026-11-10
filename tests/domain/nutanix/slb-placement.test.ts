/**
 * MAC pinning placement at boot and after a host reboot (docs/research/ovs-bond-behavior.md rule
 * 2, S8), and grey loss on the ISL (TCP resends only the lost segment, so nothing is fenced).
 */
import { describe, expect, it } from 'vitest';
import type { ActionRequest, Snapshot } from '../../../src/engine/types';
import { loadSimulation } from '../../../src/loader/simulation';
import { ISLS } from '../../../src/scenarios/ids';

const SLB = {
  'node-count': 3,
  'vm-layout': 'two',
  'storage-vswitch-layout': 'single-bond',
  'storage-vlans': 'two',
  'vs1-bond-mode': 'balance-slb',
  'array-port-vlans': 'access',
} as const;

const pins = (s: Snapshot, n: number): string[] => {
  const raw = s.devices[`node-${n}.vs1`]?.fields.pinning;
  const p = JSON.parse(typeof raw === 'string' ? raw : '{}') as Record<string, string>;
  return [p[`node-${n}.cvm.storage-a`] ?? '', p[`node-${n}.cvm.storage-b`] ?? ''];
};
const HOME = (n: number) => [`node-${n}.eth2`, `node-${n}.eth3`];
const SWAPPED = (n: number) => [`node-${n}.eth3`, `node-${n}.eth2`];

function run(options: Record<string, string | number | boolean>, plan: [number, ActionRequest][]) {
  const sim = loadSimulation({ topologyId: 't1-ahv-flasharray', options, seed: 1 }).sim;
  const end = Math.max(30, ...plan.map(([t]) => t + 1));
  const codes: string[] = [];
  let s = sim.getSnapshot();
  for (let t = 0; t < end; t++) {
    for (const [at, a] of plan) if (at === t) sim.applyAction(a);
    s = sim.tick(1);
    codes.push(...s.events.map((e) => e.code));
  }
  return { s, codes };
}

describe('MAC pinning placement', () => {
  it('boots home by default, and node 2 swapped with slb-boot-placement', () => {
    expect(pins(run(SLB, []).s, 2)).toEqual(HOME(2));
    const { s } = run({ ...SLB, 'slb-boot-placement': 'node-2-swapped' }, []);
    expect(pins(s, 1)).toEqual(HOME(1));
    expect(pins(s, 2)).toEqual(SWAPPED(2));
  });

  it('a host reboot learns the placement again: home or swapped, whatever it was before', () => {
    const reboot = (n: number): [number, ActionRequest][] => [
      [10, { kind: 'host.enter-maintenance', target: `node-${n}` }],
      [20, { kind: 'reboot', target: `node-${n}` }],
      [400, { kind: 'host.exit-maintenance', target: `node-${n}` }],
      [700, { kind: 'host.enter-maintenance', target: 'node-3' }],
    ];
    const opts = { ...SLB, 'slb-boot-placement': 'node-2-swapped' };
    // Node 1 booted home and comes back swapped; node 2 booted swapped and comes back home.
    expect(pins(run(opts, reboot(1)).s, 1)).toEqual(SWAPPED(1));
    expect(pins(run(opts, reboot(2)).s, 2)).toEqual(HOME(2));
  });
});

describe('packet loss on the ISL', () => {
  it('slows the IO that crosses it but fences nothing and times nothing out', () => {
    const loss = (pct: number, at: number): [number, ActionRequest][] =>
      ISLS.map((l) => [at, { kind: 'link.set-loss', target: l, params: { pct } }]);
    const { codes } = run({ ...SLB, 'slb-boot-placement': 'node-2-swapped' }, [
      ...loss(5, 10),
      ...loss(0, 130),
    ]);
    expect(codes).not.toContain('hades.maintenance.enter');
    expect(codes).not.toContain('nvme.io.timeout');
  });
});
