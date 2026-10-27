/**
 * Property tests (SPEC §7.1): random host / CVM / isolation failures and recoveries must keep
 * - no VM running on two hosts (`instances` ≤ 1),
 * - at most one ZK quorum side,
 * - no VM running on a fenced host, none ever on a storage-only host,
 * and the same actions + seed must give the same event log.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../../src/engine/types';
import type { TopologyId } from '../../../src/topologies';
import { harness } from './harness';

interface Step {
  readonly wait: number;
  readonly kind: string;
  readonly target: string;
}

const HOST_KINDS = ['power-off', 'power-on', 'host.isolate', 'host.unisolate', 'reboot'];
const CVM_KINDS = ['fail', 'recover', 'cvm.stop-stargate', 'cvm.start-stargate'];

function stepArb(hosts: readonly string[], cvms: readonly string[]): fc.Arbitrary<Step> {
  return fc.oneof(
    fc.record({
      wait: fc.integer({ min: 1, max: 45 }),
      kind: fc.constantFrom(...HOST_KINDS),
      target: fc.constantFrom(...hosts),
    }),
    fc.record({
      wait: fc.integer({ min: 1, max: 45 }),
      kind: fc.constantFrom(...CVM_KINDS),
      target: fc.constantFrom(...cvms),
    }),
  );
}

function violations(s: Snapshot): string[] {
  const out: string[] = [];
  const devs = Object.values(s.devices);
  const fenced = new Set(
    devs.filter((d) => d.kind === 'ahv-host' && d.fields.haState === 'fenced').map((d) => d.id),
  );
  const so = new Set(
    devs.filter((d) => d.kind === 'ahv-host' && d.fields.role === 'storage-only').map((d) => d.id),
  );
  for (const v of devs.filter((d) => d.kind === 'vm')) {
    const inst = JSON.parse(String(v.fields.instances)) as string[];
    if (inst.length > 1) out.push(`${v.id} runs on ${inst.join('+')}`);
    const host = v.fields.host;
    if (typeof host === 'string' && fenced.has(host) && v.fields.state === 'running') {
      out.push(`${v.id} running on fenced ${host}`);
    }
    if (typeof host === 'string' && so.has(host)) out.push(`${v.id} on storage-only ${host}`);
  }
  const sides = new Set(
    devs
      .filter((d) => d.kind === 'cvm' && d.fields.zkQuorum === true)
      .map((d) => d.fields.zkPartition),
  );
  if (sides.size > 1) out.push(`quorum sides ${[...sides].join(',')}`);
  return out.map((x) => `t=${s.simTime}: ${x}`);
}

function play(topology: TopologyId, steps: readonly Step[], seed: number, tail = 150) {
  const h = harness(topology, {}, seed);
  const bad: string[] = [];
  const advance = (n: number) => {
    for (let i = 0; i < n; i++) bad.push(...violations(h.run(1)));
  };
  advance(5);
  for (const st of steps) {
    h.act(st.kind, st.target);
    advance(st.wait);
  }
  advance(tail);
  return { h, bad };
}

const CASES: readonly [TopologyId, number, number][] = [
  ['t2-hci-ahv', 4, 4],
  ['t3-co-so', 7, 4],
  ['t3-co-hci', 6, 4],
  ['t1-ahv-flasharray', 4, 4],
];

describe('invariants under random failures', () => {
  it.each(CASES)(
    '%s',
    (topology, nHosts, nCvms) => {
      const hosts = Array.from({ length: nHosts }, (_, i) => `node-${i + 1}`);
      const cvms = Array.from({ length: nCvms }, (_, i) => `node-${nHosts - nCvms + i + 1}.cvm`);
      fc.assert(
        fc.property(fc.array(stepArb(hosts, cvms), { minLength: 1, maxLength: 6 }), (steps) => {
          const { bad } = play(topology, steps, 1);
          expect(bad).toEqual([]);
        }),
        { numRuns: 12, seed: 4242 },
      );
    },
    120_000,
  );
});

describe('determinism', () => {
  it('same actions and seed → identical event log', () => {
    const hosts = ['node-1', 'node-2', 'node-3', 'node-4'];
    const cvms = hosts.map((h) => `${h}.cvm`);
    fc.assert(
      fc.property(fc.array(stepArb(hosts, cvms), { minLength: 1, maxLength: 5 }), (steps) => {
        const log = (seed: number) =>
          play('t2-hci-ahv', steps, seed, 60)
            .h.events()
            .map((e) => `${e.t}|${e.code}|${e.deviceId ?? ''}|${e.text}`);
        expect(log(7)).toEqual(log(7));
      }),
      { numRuns: 6, seed: 99 },
    );
  }, 120_000);
});
