/**
 * Determinism (SPEC §5.1): the same topology, seed and action sequence always produce the same
 * event log and snapshots.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ActionRequest } from '../../src/engine';
import { fabric, flowsFor, probeSim } from './helpers';

const ACTIONS: readonly ActionRequest[] = [
  { kind: 'fail', target: 'sw-a' },
  { kind: 'recover', target: 'sw-a' },
  { kind: 'fail', target: 'h1' },
  { kind: 'recover', target: 'h1' },
  { kind: 'fail', target: 'tgt.p1' },
  { kind: 'recover', target: 'tgt.p1' },
  { kind: 'link-down', target: 'l-isl' },
  { kind: 'link-up', target: 'l-isl' },
  { kind: 'link-down', target: 'l-h2-eth0' },
  { kind: 'link-up', target: 'l-h2-eth0' },
  { kind: 'hang', target: 'l-h1-eth1' },
  { kind: 'unhang', target: 'l-h1-eth1' },
  { kind: 'hang', target: 'sw-b' },
  { kind: 'unhang', target: 'sw-b' },
  { kind: 'set-latency', target: 'l-isl', params: { ms: 5 } },
  { kind: 'switch.port.prune-vlan', target: 'l-isl', params: { vlan: 10 } },
  { kind: 'switch.port.allow-vlan', target: 'l-isl', params: { vlan: 10 } },
  { kind: 'vswitch.set-bond-mode', target: 'h1.vs1', params: { mode: 'balance-tcp' } },
  { kind: 'vswitch.set-bond-mode', target: 'h1.vs1', params: { mode: 'balance-slb' } },
  { kind: 'vswitch.set-bond-mode', target: 'h2.vs1', params: { mode: 'active-backup' } },
  { kind: 'vswitch.set-lacp-rate', target: 'h1.vs1', params: { rate: 'slow' } },
  { kind: 'vswitch.set-uplinks', target: 'h2.vs1', params: { uplinks: 'h2.eth1' } },
  { kind: 'fabric.set-mlag', target: 'sw-a', params: { enabled: 'off' } },
  { kind: 'vswitch.set-slb-vlan-aware', target: 'h1.vs1', params: { enabled: 'off' } },
];

type Step = { readonly actions: readonly number[]; readonly ticks: number };

function run(seed: number, steps: readonly Step[]): string[] {
  // Random source ports (from the seeded per-device RNG) drive bond hashing.
  const s = probeSim(
    fabric({ mlag: true, config: { slbRebalanceIntervalS: 3 } }),
    (ctx) =>
      flowsFor(ctx.rng.int(1, 6), (i) => ({
        src: i % 2 ? 'h1.cvm.ep10' : 'h2.cvm.ep10',
        dst: i % 3 ? 'tgt.ep1' : 'tgt.ep0',
        srcPort: ctx.rng.int(1024, 65535),
        size: ctx.rng.next() < 0.5 ? 'small' : 'large',
      })),
    { seed },
  );
  const out: string[] = [];
  for (const step of steps) {
    for (const a of step.actions) s.applyAction(ACTIONS[a % ACTIONS.length] as ActionRequest);
    for (let i = 0; i < step.ticks; i++) out.push(JSON.stringify(s.tick()));
  }
  out.push(JSON.stringify(s.eventLog()));
  return out;
}

const steps = fc.array(
  fc.record({
    actions: fc.array(fc.nat({ max: ACTIONS.length - 1 }), { maxLength: 3 }),
    ticks: fc.integer({ min: 1, max: 6 }),
  }),
  { minLength: 1, maxLength: 12 },
);

describe('determinism', () => {
  it('same seed + same actions ⇒ identical snapshots and event log', () => {
    fc.assert(
      fc.property(fc.nat(), steps, (seed, plan) => {
        expect(run(seed, plan)).toEqual(run(seed, plan));
      }),
      { numRuns: 40 },
    );
  });

  it('the seed actually matters', () => {
    const plan: Step[] = [{ actions: [17], ticks: 5 }];
    expect(run(1, plan)).not.toEqual(run(2, plan));
  });
});
