/**
 * Workload shape (SPEC §6.1): a steady IO generator. Not vendor behavior, so these are not profile
 * fields, but they are labeled model assumptions so nobody mistakes them for measured values.
 */
import type { Cited } from '../../engine/types';
import { cited } from '../versions/cited';

export interface WorkloadModel {
  /** Reads issued per vDisk per tick (alternating small / large size classes). */
  readonly readsPerTick: Cited<number>;
  /** Writes issued per vDisk per tick (alternating small / large). */
  readonly writesPerTick: Cited<number>;
  /** Max outstanding IOs per vDisk (guest queue depth); no new IO is issued beyond it. */
  readonly queueDepth: Cited<number>;
}

export const WORKLOAD: WorkloadModel = {
  readsPerTick: cited(
    2,
    'assumption',
    [],
    'Illustrative steady load; enough IOs per tick to touch every live path under round-robin.',
  ),
  writesPerTick: cited(
    2,
    'assumption',
    [],
    'Illustrative steady load; enough IOs per tick to touch every live path under round-robin.',
  ),
  queueDepth: cited(
    32,
    'assumption',
    [],
    'Illustrative guest queue depth per vDisk. On a silent NVMe path loss the queue-depth selector leaves one command on each IO queue of the dead path, so a guest this deep stalls only partially; round-robin fills it (SPEC §6.4c). Topology option guest-queue-depth.',
  ),
};
