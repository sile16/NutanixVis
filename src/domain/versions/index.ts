/**
 * Version resolution (SPEC §2.1). Domain code reads only the resolved `Profile`, never versions.
 */
import type { CitationId, VersionSelection } from '../../engine/types';
import { type Citation, citations } from '../citations';
import { versionMatrix } from './matrix';
import type { FlashArrayRelease, NutanixRelease, Profile, VersionMatrix } from './profile';
import { current } from './profiles/current';

export { cited, RECONNECT_FOREVER } from './cited';
export type { FlashArrayRelease, NutanixRelease, Profile, VersionMatrix } from './profile';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** All behavior profiles, by id. */
export const profiles: Readonly<Record<string, Profile>> = deepFreeze({ [current.id]: current });

export const matrix: VersionMatrix = deepFreeze(versionMatrix);

export function getProfile(id: string): Profile {
  const p = profiles[id];
  if (!p) throw new Error(`Unknown profile id: ${id}`);
  return p;
}

/** Look up a citation; throws on an unknown id. */
export function cite(id: CitationId): Citation {
  const c = citations[id];
  if (!c) throw new Error(`Unknown citation id: ${id}`);
  return c;
}

export interface ResolvedVersions {
  readonly nutanix: NutanixRelease;
  readonly flasharray?: FlashArrayRelease;
  readonly profile: Profile;
  readonly selection: VersionSelection;
}

/**
 * Resolve a (Nutanix, FlashArray) selection. Missing or unknown Nutanix ids resolve to the newest
 * release; missing or unsupported FlashArray ids resolve to the newest supported FlashArray
 * release. With `hasArray: false` no FlashArray release is selected. Defaults to `hasArray: true`.
 */
export function resolveVersions(
  selection: { readonly nutanix?: string; readonly flasharray?: string } = {},
  opts: { readonly hasArray: boolean } = { hasArray: true },
): ResolvedVersions {
  const newest = matrix[0];
  if (!newest) throw new Error('Version matrix is empty');
  const nutanix = matrix.find((r) => r.id === selection.nutanix) ?? newest;

  const flasharray = opts.hasArray
    ? (nutanix.flasharray.find((f) => f.id === selection.flasharray) ?? nutanix.flasharray[0])
    : undefined;

  const profileId = flasharray?.profileId ?? nutanix.profileId;
  const profile = getProfile(profileId);

  if (!flasharray) {
    return { nutanix, profile, selection: { nutanix: nutanix.id, profileId } };
  }
  return {
    nutanix,
    flasharray,
    profile,
    selection: { nutanix: nutanix.id, flasharray: flasharray.id, profileId },
  };
}
