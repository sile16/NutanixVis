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
/** NVMe Command Quiesce Time: the last part of the wait before in-flight IO on a lost path retries. */
export const CQT = P.externalStorage.commandQuiesceTimeS;
/**
 * Worst case for one command when a path is lost silently: it is retried at k × KATO + CQT after
 * the path's last successful exchange (k = `lostPathHoldKatoMultiplier`, 3; SPEC §6.4c), ≈ 45 s.
 */
export const PATH_LOSS_WORST = P.externalStorage.lostPathHoldKatoMultiplier * KATO + CQT;
/** `PATH_LOSS_WORST` as a rule, for expectation labels. */
export const PATH_LOSS_RULE = `${P.externalStorage.lostPathHoldKatoMultiplier} × KATO + CQT`;
/**
 * Worst case for one command when the target closes the connection (a disabled FA IP, a graceful
 * controller reboot): the path is lost at once and in-flight IO waits CQT only (NVMe 2.1 §9.6.2
 * step 2c; SPEC §6.4c).
 */
export const CLOSED_PATH_WORST = CQT;
/**
 * Initiator detection of a silent Stargate: `missesToUnhealthy` unanswered NOPs, `nopIntervalS`
 * apart (SPEC §6.2 "iSCSI redirector"). One NOP cycle of a parked session takes as long.
 */
export const REDIRECT_DETECT = P.redirector.missesToUnhealthy * P.redirector.nopIntervalS;
/** IO pause when a Stargate's connections are reset (orderly stop, process exit): the re-login. */
export const RESET_PAUSE = P.redirector.redirectStallS;

/**
 * A silent Stargate (node power loss, hang, isolation) is declared down when its Zookeeper
 * session expires; until then, writes that need a replica on it stall (SPEC §6.3), and peers
 * may not take its vDisks (their leadership is still its).
 */
export const STARGATE_DOWN = P.hci.stargateDownDetectS;
/** Curator rebuild start after a node loss: Stargate-down detection, then the start delay. */
export const NODE_REBUILD_START = STARGATE_DOWN + P.hci.rebuildStartDelayS;
/**
 * Worst VM IO pause when its Stargate goes silent or its CVM reboots: the vDisk leadership is
 * released at the ZK session expiry, then a parked session gets IO at its next NOP cycle, plus the
 * re-login. A redirect that comes earlier only parks.
 */
export const SILENT_PAUSE = STARGATE_DOWN + REDIRECT_DETECT + P.redirector.redirectStallS;
/** No IO pause shorter than this for a silent Stargate: its leadership holds until ZK expiry. */
export const SILENT_PAUSE_MIN = STARGATE_DOWN;
/** Worst VM IO pause when a node's Stargate goes silent: the redirect or the replica-write stall. */
export const SILENT_NODE_PAUSE = Math.max(SILENT_PAUSE, STARGATE_DOWN);
/**
 * Failback of a host's sessions after the local Stargate is back: `failbackStableS`, then one vDisk
 * per `failbackStepS` (`vdisks` of them), each with the re-login pause.
 */
export function failbackDoneS(vdisks: number): number {
  const R = P.redirector;
  return R.failbackStableS + Math.max(0, vdisks - 1) * R.failbackStepS + R.redirectStallS;
}

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
/**
 * T1: a loss of every array path at T0 makes the service-volume mounts fail (and stay bad) at
 * `MOUNT_FAIL`: paths are lost after KATO (keep-alive), then multipath fails the IO after its
 * fast-IO-fail time (`hades.mountFailAfterS`). A shorter loss is a plain stall.
 */
export const MOUNT_FAIL = KATO + P.hades.mountFailAfterS;
/**
 * T1 Hades: worst case from a silent loss of every array path to maintenance mode: the mounts
 * fail, the volume monitor (every `volumeMonitorIntervalS`) sees it, and the error must last
 * `externalStorageErrorThresholdS`.
 */
export const HADES_DETECT =
  MOUNT_FAIL + P.hades.volumeMonitorIntervalS + P.hades.externalStorageErrorThresholdS;
/** Earliest maintenance after the loss: the mounts fail, plus the 5 s threshold. */
export const HADES_EARLIEST = MOUNT_FAIL + P.hades.externalStorageErrorThresholdS;
/** T1: a remote Stargate takes over a vDisk whose owner CVM went into Hades maintenance. */
export const VDISK_HANDOVER = P.externalStorage.vdiskHandoverS;
/**
 * Hades maintenance exit after the paths return: the controllers reconnect (`reconnectDelayS`),
 * the next volume check finds the mounts healthy and the node leaves maintenance.
 */
export const HADES_EXIT = P.externalStorage.reconnectDelayS + P.hades.volumeMonitorIntervalS;
/** Paths back → services serving again: maintenance exit, then the services restart. */
export const HADES_RECOVER = HADES_EXIT + P.hades.servicesRestartS;

/** T1 simultaneous node failures tolerated (N−2 below 5 nodes, N−3 at 5+; DEPLOY-GUIDE). */
export function t1Tolerance(nodes: number): number {
  const t = current.externalStorage.nodeFailureTolerance.value;
  return Math.max(0, nodes - (nodes < 5 ? t.belowFiveNodes : t.fiveOrMore));
}
