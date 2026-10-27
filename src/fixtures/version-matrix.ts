/**
 * Fixture version matrix for the UI (stream B). NOT compatibility data: stream C owns the real
 * matrix in `src/domain/versions/matrix.ts`. The second Nutanix entry exists only so the UI can
 * demonstrate (and e2e-test) that the FlashArray list is filtered per Nutanix release.
 */
import type { VersionMatrix } from '../domain/versions/profile';

export const fixtureVersionMatrix: VersionMatrix = [
  {
    id: 'aos-7.6',
    label: 'AOS 7.6 · AHV 11.0',
    aos: '7.6',
    ahv: '11.0',
    profileId: 'current',
    flasharray: [
      { id: 'purity-6.12', label: 'Purity//FA 6.12' },
      { id: 'purity-6.11.8', label: 'Purity//FA 6.11.8' },
    ],
    cite: [],
  },
  {
    id: 'fixture-aos-7.5',
    label: 'AOS 7.5 (fixture)',
    aos: '7.5',
    ahv: '10.3',
    profileId: 'current',
    flasharray: [{ id: 'purity-6.11.8', label: 'Purity//FA 6.11.8' }],
    cite: [],
  },
];
