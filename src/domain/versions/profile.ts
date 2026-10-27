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
    readonly keepAliveTimeoutS: Cited<number>;
    readonly reconnectDelayS: Cited<number>;
    readonly controllerLossTimeoutS: Cited<number>;
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
