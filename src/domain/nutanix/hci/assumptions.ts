/**
 * HCI data-path model constants that are not (yet) `Profile` fields. Each one is `Cited` with its
 * confidence so the UI and docs can label it. Values a profile should own are listed in
 * `PROFILE_REQUESTS` (stream G report); until they land they live here, never as inline literals.
 */
import type { Cited } from '../../../engine/types';
import { cited as c } from '../../versions/cited';

export const HCI_ASSUMPTIONS = {
  /** Model granularity: each vDisk is E extent groups (SPEC §6.3). Not a vendor value. */
  extentGroupsPerVdisk: c(
    8,
    'assumption',
    [],
    'Model granularity (SPEC §6.3 default). Real extent groups are ~1–4 MiB, so a vDisk has thousands.',
  ),
  /**
   * Curator re-replication throughput contributed by each surviving CVM node. The total rate is
   * this × N, so each node does ~1/N of the work (Bible 4i).
   */
  rebuildGiBpsPerNode: c(
    1,
    'assumption',
    ['ntnx-bible-4i'],
    'No published per-node figure. Chosen to land in the range of a public lab test (>5 TB rebuilt in <20 min, ~9 GBps cluster-wide; Josh Odgers, "Nutanix resiliency part 1", 2018).',
  ),
  /** Physical used capacity (replicas included) as % of raw, at t=0. Runtime: `hci.set-capacity`. */
  initialUsedCapacityPct: c(
    20,
    'assumption',
    [],
    'Illustrative starting fill. Drives replica size, hence rebuild duration.',
  ),
  /** Hades SMART test duration once a disk's fault clears. */
  diskSmartCheckS: c(10, 'assumption', ['ntnx-bible-4i'], 'Bible 4i gives no duration.'),
  /** Stargate replication / remote-read RPC: no ack within this → replica treated as unreachable. */
  replicaAckTimeoutS: c(
    2,
    'assumption',
    [],
    'No published Stargate RPC timeout. Short, so a dropped replica write is re-placed within a few ticks.',
  ),
  /** Window for `diskOfflineEventsPerHourToStayOffline` (the rule is "per hour"). */
  diskOfflineWindowS: c(3600, 'verified', ['ntnx-bible-4i'], '"3 times within an hour".'),
} as const satisfies Record<string, Cited<number>>;

/** Block-awareness rule (Bible 4i "Block Fault Tolerant Data Placement"). */
export const BLOCK_RULE = {
  /** Minimum blocks: FT1 needs 3, FT2 needs 5 (same minimum unit counts as nodes). */
  minBlocks: c({ ft1: 3, ft2: 5 }, 'verified', ['ntnx-bible-4i']),
  /** With X = nodes in the largest block, the other blocks must hold ≥ factor·X nodes. */
  remainderFactor: c({ ft1: 2, ft2: 4 }, 'verified', ['ntnx-bible-4i']),
} as const;

/** Stargate's data port, for flow identity only (illustrative). */
export const STARGATE_PORT = 2009;
