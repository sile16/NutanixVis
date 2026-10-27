/**
 * HCI data-path rule constants that are not version-dependent. Tunable model values (extent groups,
 * rebuild rate, SMART check, ack timeout, …) live in `Profile.hci`.
 */
import { cited as c } from '../../versions/cited';

/** Block-awareness rule (Bible 4i "Block Fault Tolerant Data Placement"). */
export const BLOCK_RULE = {
  /** Minimum blocks: FT1 needs 3, FT2 needs 5 (same minimum unit counts as nodes). */
  minBlocks: c({ ft1: 3, ft2: 5 }, 'verified', ['ntnx-bible-4i']),
  /** With X = nodes in the largest block, the other blocks must hold ≥ factor·X nodes. */
  remainderFactor: c({ ft1: 2, ft2: 4 }, 'verified', ['ntnx-bible-4i']),
} as const;

/** Stargate's data port, for flow identity only (illustrative). */
export const STARGATE_PORT = 2009;
