/**
 * Profile timers for scenario expectations. Scenarios read timer values by profile field name
 * (`P.ahvHa.restartByS`) rather than literals, so expectations track the active profile, including
 * its labeled `assumption` values (redirect stall, NVMe keep-alive/reconnect).
 *
 * A scenario that pins `versions` must still use the profile those versions resolve to; v1 has
 * a single profile, so `P` is the current one.
 */

import type { Profile } from '../domain/versions/profile';
import { current } from '../domain/versions/profiles/current';
import type { Cited } from '../engine/types';
import { buildTopology, type OptionValues, type TopologyId } from '../topologies';

type Section = Exclude<keyof Profile, 'id' | 'label'>;
type NumericKeys<T> = { [K in keyof T]-?: T[K] extends Cited<number> ? K : never }[keyof T];

/** Every `Cited<number>` field of `Profile`, as a plain number, under the same names. */
export type NumericProfile = {
  readonly [S in Section]: { readonly [K in NumericKeys<Profile[S]>]: number };
};

function isCitedNumber(v: unknown): v is Cited<number> {
  return typeof v === 'object' && v !== null && 'value' in v && typeof v.value === 'number';
}

/** Project a profile onto its numeric timer/threshold fields. */
export function numericView(profile: Profile): NumericProfile {
  const out: Record<string, Record<string, number>> = {};
  for (const [section, fields] of Object.entries(profile)) {
    if (typeof fields !== 'object' || fields === null) continue;
    const nums: Record<string, number> = {};
    for (const [key, v] of Object.entries(fields)) if (isCitedNumber(v)) nums[key] = v.value;
    out[section] = nums;
  }
  return out as unknown as NumericProfile;
}

export const P: NumericProfile = numericView(current);

/** NVMe keep-alive timeout: a silent path is lost KATO after its last exchange (SPEC §6.4c). */
export const KATO = P.externalStorage.keepAliveTimeoutS;
/** NVMe Command Quiesce Time: in-flight commands on a lost path are held CQT, then retried. */
export const CQT = P.externalStorage.commandQuiesceTimeS;
/** Worst case for one command when a path is lost silently: about KATO + CQT (SPEC §6.4c). */
export const PATH_LOSS_WORST = KATO + CQT;
/** Redirector detection: NOP misses needed to mark a Stargate unhealthy, in seconds. */
export const REDIRECT_DETECT = P.redirector.missesToUnhealthy * P.redirector.nopIntervalS;
/** Detection plus the (assumed) IO stall while QEMU re-logs in to the new Stargate. */
export const REDIRECT_PAUSE = REDIRECT_DETECT + P.redirector.redirectStallS;

/**
 * A silent Stargate (node power loss, hang, isolation) is declared down when its Zookeeper
 * session expires; until then, writes that need a replica on it stall (SPEC §6.3).
 */
export const STARGATE_DOWN = P.hci.stargateDownDetectS;
/** Curator rebuild start after a node loss: Stargate-down detection, then the start delay. */
export const NODE_REBUILD_START = STARGATE_DOWN + P.hci.rebuildStartDelayS;
/** Worst VM IO pause when a node's Stargate goes silent: the redirect or the replica-write stall. */
export const SILENT_NODE_PAUSE = Math.max(REDIRECT_PAUSE, STARGATE_DOWN);

/**
 * Curator copy time for one lost CVM node (SPEC §6.3 "Curator rebuild", Bible 4i): its share of
 * the used capacity (placement is balanced, so `initialUsedCapacityPct` of its own raw capacity),
 * spread over `survivors` nodes at `hci.rebuildGiBpsPerNode` each. Both inputs are `assumption`s.
 */
export function nodeRebuildS(
  topology: TopologyId,
  node: string,
  survivors: number,
  options: OptionValues = {},
): { lostGiB: number; seconds: number } {
  const rawTiB = buildTopology(topology, options)
    .devices.filter((d) => d.kind === 'disk' && d.parent === node)
    .reduce((sum, d) => sum + (d.kind === 'disk' ? d.capacityTiB : 0), 0);
  const lostGiB = (P.hci.initialUsedCapacityPct / 100) * rawTiB * 1024;
  return { lostGiB, seconds: lostGiB / (P.hci.rebuildGiBpsPerNode * survivors) };
}
