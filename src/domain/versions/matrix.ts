/**
 * Version matrix (SPEC §2.1): Nutanix releases newest first, each with its supported Purity//FA
 * releases newest first. Sources and confidence: docs/research/nutanix-flasharray.md §1.
 *
 * AOS 7.6 lists only Purity//FA 6.11.8+ and 6.12.x: the deployment guide's NVMe/TCP requirement
 * is Purity//FA 6.11.8, and the 7.6 behavior this profile models (1:1 vDisk→volume, 10,000
 * vDisks) needs 6.11.8+ or 6.12.0+ (Everpure release notes and requirements KB).
 */
import type { KnownCitationId } from '../citations';
import type { NutanixRelease, VersionMatrix } from './profile';

const aos76Cite: readonly KnownCitationId[] = [
  'ntnx-ncp-everpure-deploy-7.6',
  'ntnx-ncp-everpure-compat-7.6',
  'ntnx-storage-compat-matrix',
  'everpure-nutanix-req',
  'everpure-nutanix-rn',
  'ntnx-ahv-admin-11.2',
];

const aos76: NutanixRelease = {
  id: 'aos-7.6',
  label: 'AOS 7.6 / AHV 11.2',
  aos: '7.6',
  ahv: '11.2',
  profileId: 'current',
  flasharray: [
    { id: 'purity-6.12', label: 'Purity//FA 6.12.x' },
    { id: 'purity-6.11', label: 'Purity//FA 6.11.8+' },
  ],
  cite: aos76Cite,
};

export const versionMatrix: VersionMatrix = [aos76];
