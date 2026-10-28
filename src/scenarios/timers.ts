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
/** Redirector detection: NOP misses needed to mark a Stargate unhealthy, in seconds. */
export const REDIRECT_DETECT = P.redirector.missesToUnhealthy * P.redirector.nopIntervalS;
/** Detection plus the (assumed) IO stall while QEMU re-logs in to the new Stargate. */
export const REDIRECT_PAUSE = REDIRECT_DETECT + P.redirector.redirectStallS;
