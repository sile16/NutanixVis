/**
 * Two-level version selector logic (SPEC §2.1), pure. Nutanix release first; the FlashArray list
 * shows only releases supported for it. Both default to newest; a FlashArray selection that
 * becomes unsupported resets to the newest supported one.
 */
import type { FlashArrayRelease, VersionMatrix } from '../../domain/versions/profile';
import type { VersionSelection } from '../../engine/types';
import type { VersionChoice } from '../store/ui-store';

export function supportedFlashArray(
  matrix: VersionMatrix,
  nutanixId: string,
): readonly FlashArrayRelease[] {
  return matrix.find((r) => r.id === nutanixId)?.flasharray ?? [];
}

export function defaultVersions(matrix: VersionMatrix): VersionChoice {
  const newest = matrix[0];
  return { nutanix: newest?.id ?? '', flasharray: newest?.flasharray[0]?.id };
}

/** Normalise a choice against the matrix (unknown Nutanix → newest; unsupported FA → newest). */
export function resolveVersions(matrix: VersionMatrix, choice: VersionChoice): VersionChoice {
  const release = matrix.find((r) => r.id === choice.nutanix) ?? matrix[0];
  if (!release) return { nutanix: '', flasharray: undefined };
  const fa = release.flasharray.find((f) => f.id === choice.flasharray) ?? release.flasharray[0];
  return { nutanix: release.id, flasharray: fa?.id };
}

export function selectNutanix(
  matrix: VersionMatrix,
  current: VersionChoice,
  nutanix: string,
): VersionChoice {
  return resolveVersions(matrix, { nutanix, flasharray: current.flasharray });
}

/** The engine-facing selection; `profileId` comes from the FA override or the Nutanix release. */
export function toVersionSelection(
  matrix: VersionMatrix,
  choice: VersionChoice,
  hasFlashArray: boolean,
): VersionSelection {
  const resolved = resolveVersions(matrix, choice);
  const release = matrix.find((r) => r.id === resolved.nutanix);
  const fa = release?.flasharray.find((f) => f.id === resolved.flasharray);
  const profileId = (hasFlashArray ? fa?.profileId : undefined) ?? release?.profileId ?? 'current';
  return hasFlashArray && resolved.flasharray
    ? { nutanix: resolved.nutanix, flasharray: resolved.flasharray, profileId }
    : { nutanix: resolved.nutanix, profileId };
}
