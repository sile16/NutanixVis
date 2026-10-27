/**
 * Version contract — the version matrix and behavior-profile types (SPEC §2.1, §13.1).
 * Domain modules read timers/thresholds/flags ONLY from the active `Profile`; they never branch
 * on version strings. Stream C fills `matrix.ts` and `profiles/*.ts`; the shape is owned by the
 * integrator.
 */
import type { CitationId, Cited } from '../../engine/types';

export type MultipathPolicy = 'active-active' | 'active-passive';

export interface Profile {
  readonly id: string;
  readonly label: string;

  /** AHV HA (Bible 5b; AHV Admin Guide "Fault Detection for High Availability"). */
  readonly ahvHa: {
    readonly heartbeatIntervalS: Cited<number>;
    readonly timeoutStartS: Cited<number>;
    readonly disconnectTimeoutS: Cited<number>;
    readonly fenceAtS: Cited<number>;
    readonly restartByS: Cited<number>;
    readonly isolatedVmSelfTerminateS: Cited<number>;
    readonly leaderReelectionS: Cited<number>;
    readonly vswitchQuickUpdateHaTriggerS: Cited<number>;
  };

  /** AHV iSCSI redirector / Autopath. */
  readonly redirector: {
    readonly nopIntervalS: Cited<number>;
    readonly missesToUnhealthy: Cited<number>;
    readonly missWindowS: Cited<number>;
    readonly failbackStableS: Cited<number>;
    readonly redirectStallS: Cited<number>;
  };

  readonly cluster: {
    readonly zkMembersFt1: Cited<number>;
    readonly zkMembersFt2: Cited<number>;
    readonly cassandraRingDetachS: Cited<number>;
    readonly minNodes: Cited<number>;
    /** CVM power-on to Stargate up. */
    readonly cvmBootS: Cited<number>;
  };

  /** HCI data path (T2/T3). */
  readonly hci: {
    readonly rebuildStartDelayS: Cited<number>;
    readonly curatorPartialScanS: Cited<number>;
    readonly curatorFullScanS: Cited<number>;
    readonly diskOfflineEventsPerHourToStayOffline: Cited<number>;
    readonly readOnlyCapacityPct: Cited<number>;
    readonly capacityWarnPct: Cited<number>;
    readonly vdiskOwnerMigrationRemoteIoS: Cited<number>;
    /** Model granularity: extent groups per vDisk. */
    readonly extentGroupsPerVdisk: Cited<number>;
    /** Curator re-replication throughput per surviving CVM node (total = this × N). */
    readonly rebuildGiBpsPerNode: Cited<number>;
    /** Physical used capacity at t=0 (% of raw, replicas included). */
    readonly initialUsedCapacityPct: Cited<number>;
    /** Hades SMART check duration once a disk's fault clears. */
    readonly diskSmartCheckS: Cited<number>;
    /** Window for `diskOfflineEventsPerHourToStayOffline`. */
    readonly diskOfflineWindowS: Cited<number>;
    /** Stargate replication / remote-read RPC: no ack within this → replica treated unreachable. */
    readonly replicaAckTimeoutS: Cited<number>;
  };

  /** AHV virtual switch bonds (AHV Admin Guide Table 9). */
  readonly bond: {
    readonly lacpFastDetectS: Cited<number>;
    readonly lacpSlowDetectS: Cited<number>;
    readonly slbRebalanceIntervalS: Cited<number>;
  };

  /** Nutanix side of external storage (T1). */
  readonly externalStorage: {
    readonly vdiskVolumeMapping: Cited<'1:1'>;
    readonly maxVdisksPerCluster: Cited<number>;
    readonly minNodes: Cited<number>;
    /** Simultaneous node failures tolerated, as a function of node count N. */
    readonly nodeFailureTolerance: Cited<{
      readonly belowFiveNodes: number;
      readonly fiveOrMore: number;
    }>;
    readonly pathLossDefault: Cited<'retry-until-array-responds'>;
    readonly multipathPolicy: Cited<MultipathPolicy>;
    readonly ioQueuesPerPath: Cited<number>;
    /**
     * NVMe Keep Alive Timeout (KATO). The host sends Keep Alive at KATO/2; a path whose keep-alive
     * goes unanswered for KATO is declared lost (SPEC §6.4c).
     */
    readonly keepAliveTimeoutS: Cited<number>;
    /**
     * NVMe Command Quiesce Time (CQT, TP4129). After a path is declared lost, commands that were in
     * flight on it are held for CQT before being retried on another path, so the target can quiesce
     * them first (prevents stale-write corruption). New IO uses surviving paths immediately.
     */
    readonly commandQuiesceTimeS: Cited<number>;
    /** Delay between reconnect attempts on a lost path. */
    readonly reconnectDelayS: Cited<number>;
    /**
     * Controller-loss timeout: how long a lost path keeps reconnecting before its controller is
     * deleted. If every path to the namespace is deleted, queued IO fails to the guest.
     * `RECONNECT_FOREVER` (-1) = never delete.
     */
    readonly controllerLossTimeoutS: Cited<number>;
    /** Per-command NVMe IO timeout: an IO stuck on a live-but-broken queue is aborted and retried. */
    readonly ioTimeoutS: Cited<number>;
  };

  /** Everpure FlashArray controller HA (Purity HA KBs). */
  readonly flasharray: {
    readonly claimExpiryDetectS: Cited<number>;
    readonly primaryCrashPauseS: Cited<number>;
    readonly promotionMaxS: Cited<number>;
    readonly ioDelayTimeoutS: Cited<number>;
    readonly failoverObjectiveS: Cited<number>;
    readonly plannedFailoverPauseS: Cited<number>;
    readonly hostMultipathRetryS: Cited<number>;
    readonly worstCaseSingleIoS: Cited<number>;
    /** One controller reboot during NDU (ports absent meanwhile). */
    readonly controllerRebootS: Cited<number>;
  };

  readonly guest: {
    readonly linuxScsiTimeoutS: Cited<number>;
  };
}

export interface FlashArrayRelease {
  /** e.g. 'purity-6.12' */
  readonly id: string;
  readonly label: string;
  /** Optional per-pair behavior override; defaults to the Nutanix release's profile. */
  readonly profileId?: string;
}

export interface NutanixRelease {
  /** e.g. 'aos-7.6' */
  readonly id: string;
  readonly label: string;
  readonly aos: string;
  readonly ahv: string;
  readonly profileId: string;
  /** Supported Purity//FA releases for the external-storage topologies, newest first. */
  readonly flasharray: readonly FlashArrayRelease[];
  readonly cite: readonly CitationId[];
}

/** Newest first. The UI defaults to element 0 and its first supported FlashArray release. */
export type VersionMatrix = readonly NutanixRelease[];
