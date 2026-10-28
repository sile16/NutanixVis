/**
 * Version contract — the version matrix and behavior-profile types (SPEC §2.1, §13.1).
 * Domain modules read timers/thresholds/flags ONLY from the active `Profile`; they never branch
 * on version strings. Stream C fills `matrix.ts` and `profiles/*.ts`; the shape is owned by the
 * integrator.
 */
import type { CitationId, Cited } from '../../engine/types';

export type MultipathPolicy = 'active-active' | 'active-passive';
/**
 * How `active-active` picks a path for each new command (SPEC §6.4b). `queue-depth`: the live path
 * with the fewest outstanding commands; `round-robin`: the next live path in turn.
 */
export type PathSelector = 'queue-depth' | 'round-robin';

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
    /**
     * After a per-VM path-loss force-shutdown, AHV HA restarts the VM "at the next HA cycle"
     * (SPEC §14 #7); modeled as this many heartbeat intervals.
     */
    readonly forceShutdownRestartCycles: Cited<number>;
    /**
     * HCI (T2/T3): with no partition holding quorum anywhere, a VM whose IO fails still
     * self-terminates `isolatedVmSelfTerminateS` after its first failed IO, and the next
     * Acropolis leader restarts it once quorum re-forms. External storage (T1) never does this:
     * its IO retries until the array responds.
     */
    readonly selfTerminateWithoutQuorum: Cited<boolean>;
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
    /** A detached Cassandra node is re-added to the ring after it has been stable this long. */
    readonly cassandraRejoinStableS: Cited<number>;
    /** Host power-cycle time for `reboot` (POST + AHV boot), before its CVM starts booting. */
    readonly hostRebootS: Cited<number>;
    /**
     * Zookeeper session timeout: how long cluster services (and Prism Element) keep running after
     * ZK reachability is lost before they are declared down. IO effects are not delayed.
     */
    readonly zkSessionTimeoutS: Cited<number>;
    /**
     * External storage (T1): ZK/Cassandra service volumes move off a failed active node onto an
     * inactive one only after this delay, and never during an upgrade.
     */
    readonly serviceVolumeMigrationDelayS: Cited<number>;
  };

  /**
   * Hades on external storage (T1): the CVM's kernel NVMe/TCP + dm-multipath path to its
   * per-node service volumes (Zookeeper, Cassandra, Curator).
   */
  readonly hades: {
    /** Losing the service volumes puts the node in maintenance mode (CVM services stop). */
    readonly maintenanceOnStorageError: Cited<boolean>;
    readonly volumeMonitorIntervalS: Cited<number>;
    /** An external-storage error lasting this long is critical: the node enters maintenance. */
    readonly externalStorageErrorThresholdS: Cited<number>;
    /** Hades re-maps (connects) every NVMf service volume at this interval. */
    readonly mapNvmfVolumesIntervalS: Cited<number>;
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
    /**
     * A peer Stargate that goes silent (node power loss, hang, network isolation) is declared down
     * when its Zookeeper session expires. Until then, writes needing a replica on it stall; the
     * rebuild clock (`rebuildStartDelayS`) starts at the declaration.
     */
    readonly stargateDownDetectS: Cited<number>;
    /** A cleanly stopped Stargate closes its Zookeeper session: declared down this fast. */
    readonly stargateStopDetectS: Cited<number>;
  };

  /** AHV virtual switch bonds (AHV Admin Guide Table 9). */
  readonly bond: {
    readonly lacpFastDetectS: Cited<number>;
    readonly lacpSlowDetectS: Cited<number>;
    readonly slbRebalanceIntervalS: Cited<number>;
    /**
     * `lacp-fallback-ab` on LACP (balance-tcp) bonds: with no member negotiated, the bond runs
     * active-backup; a timed-out member is detached while another is still negotiated.
     */
    readonly lacpFallbackAb: Cited<boolean>;
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
    /** Path selector for `active-active`; the `nvme-path-selector` topology option overrides it. */
    readonly pathSelector: Cited<PathSelector>;
    readonly ioQueuesPerPath: Cited<number>;
    /**
     * NVMe Keep Alive Timeout (KATO). The host sends Keep Alive at KATO/2; a path whose keep-alive
     * goes unanswered for KATO is declared lost (SPEC §6.4c). The spec allows detection anywhere
     * from KATO to 1.5 × KATO; the model uses KATO, deterministically.
     */
    readonly keepAliveTimeoutS: Cited<number>;
    /**
     * NVMe Command Quiesce Time (CQT, TP4129). Commands in flight on a lost path are not retried on
     * another path until the target has had time to detect the loss and then CQT to quiesce them
     * (prevents stale-write corruption). See `lostPathHoldKatoMultiplier`.
     */
    readonly commandQuiesceTimeS: Cited<number>;
    /**
     * Commands in flight on a silently lost path are retried on another path at
     * `lostPathHoldKatoMultiplier × KATO + CQT` after the path's last successful exchange (NVMe Base
     * Spec 2.1 §9.6.2: the controller detects the loss within 2 × KATT with command-based or 3 × KATT
     * with traffic-based keep-alive; then CQT). On a connection the target closed, only CQT applies.
     */
    readonly lostPathHoldKatoMultiplier: Cited<number>;
    /** Delay between reconnect attempts on a lost path. */
    readonly reconnectDelayS: Cited<number>;
    /**
     * Controller-loss timeout: how long a lost path keeps reconnecting before its controller is
     * deleted. If every path to the namespace is deleted, queued IO fails to the guest.
     * `RECONNECT_FOREVER` (-1) = never delete.
     */
    readonly controllerLossTimeoutS: Cited<number>;
    /**
     * Per-command NVMe IO timeout: an IO stuck on a live-but-broken queue is aborted and retried.
     * Must be at least the lost-path hold, or a command could be retried while still in flight.
     */
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
    /** Illustrative array service time added to IO completions (never drives timing). */
    readonly serviceTimeMs: Cited<{ readonly read: number; readonly write: number }>;
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
