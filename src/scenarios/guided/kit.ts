/**
 * Shared pieces of the guided scenarios (the UI's Scenario tab). Each guided scenario is written
 * once per storage-network configuration it applies to (`src/topologies/t1-configs.ts`), with a
 * walkthrough in that configuration's terms, and runs on exactly that configuration's options so
 * the topology menu stays truthful while it is loaded.
 */
import type { Snapshot } from '../../engine/types';
import { T1_CONFIGS, type T1Config, type T1ConfigKey } from '../../topologies/t1-configs';
import type { Expectation, ScenarioContext, ScenarioDef } from '../define';
import { allCvms, allPathsLive, at, isRunning, T0, vm } from '../helpers';
import { ISLS, vmId } from '../ids';

export const VM1 = vmId(1, 1);
export const VM2 = vmId(2, 1);

/** One guided scenario: the same failure, a walkthrough per configuration. */
export interface GuidedFamily {
  /** Order in the Scenario menu (1-based). */
  readonly n: number;
  readonly slug: string;
  /** Menu title, the same on every configuration. */
  readonly title: string;
  readonly configs: readonly T1ConfigKey[];
  readonly build: (c: T1Config) => ScenarioDef;
}

export const guidedId = (n: number, slug: string, key: T1ConfigKey): string =>
  `guided-${String(n).padStart(2, '0')}-${slug}--${key}`;

export const ALL_CONFIGS: readonly T1ConfigKey[] = T1_CONFIGS.map((c) => c.key);
export const BONDED_CONFIGS: readonly T1ConfigKey[] = [
  'slb-4ip',
  'slb-8ip',
  'lacp-4ip',
  'lacp-8ip',
];
export const SLB_CONFIGS: readonly T1ConfigKey[] = ['slb-4ip', 'slb-8ip'];

/** Words for the configuration in walkthrough text. */
export const layoutWords = (c: T1Config): string =>
  c.bond === 'none'
    ? 'two storage vSwitches without a bond'
    : `one storage vSwitch with a ${c.bond === 'lacp' ? 'LACP' : 'MAC-pinning'} bond and ${c.arrayIps} array IPs`;

const isIsl = (l: string): boolean => (ISLS as readonly string[]).includes(l);

/** Node `n`'s NVMe/TCP IO frames in `s`: how many, and how many crossed the ISL. */
function islCount(s: Snapshot, n: number, dir: 'out' | 'back'): { all: number; crossed: number } {
  let all = 0;
  let crossed = 0;
  const mine = `node-${n}.cvm.storage`;
  for (const t of s.traces) {
    if (t.result !== 'delivered' || t.category !== 'nvme-io') continue;
    const end = dir === 'out' ? t.src : t.dst;
    if (!end?.startsWith(mine)) continue;
    all++;
    if (t.links.some(isIsl)) crossed++;
  }
  return { all, crossed };
}

/**
 * Share of node `n`'s NVMe/TCP IO frames that crossed the ISL over the ticks `from`..`to`:
 * `out` = host → array (commands, write data), `back` = array → host (completions, read data).
 * Null with no IO.
 */
export function islShareOver(
  ctx: ScenarioContext,
  from: number,
  to: number,
  n: number,
  dir: 'out' | 'back',
): number | null {
  let all = 0;
  let crossed = 0;
  for (const s of ctx.history) {
    if (s.simTime < from || s.simTime > to) continue;
    const c = islCount(s, n, dir);
    all += c.all;
    crossed += c.crossed;
  }
  return all === 0 ? null : crossed / all;
}

/** A VM's IO latency field (ms) at `s`, or null while it has none. */
export function vmLatencyMs(s: Snapshot, vm: string): number | null {
  const v = s.devices[vm]?.fields.ioLatencyMs;
  return typeof v === 'number' ? v : null;
}

/** Highest VM IO latency (ms) over the ticks `from`..`to`. */
export function peakLatencyMs(ctx: ScenarioContext, vm: string, from: number, to: number): number {
  let peak = 0;
  for (const s of ctx.history) {
    if (s.simTime < from || s.simTime > to) continue;
    peak = Math.max(peak, vmLatencyMs(s, vm) ?? 0);
  }
  return peak;
}

/** Steady state at T0 in the guided configuration: the test VMs run (the spare is off). */
export const guidedSteady = (): Expectation[] => [
  at(T0, 'steady state: both test VMs running', (s) =>
    [VM1, VM2].every((v) => isRunning(vm(s, v))),
  ),
  at(T0, 'steady state: every CVM has all NVMe paths live', (s) => allCvms(s, allPathsLive)),
];
