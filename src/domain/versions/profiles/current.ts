/**
 * Behavior profile for the current release: AOS 7.6 / AHV 11.2, with Purity//FA 6.11.8+ or 6.12.x
 * for external storage. Audit table: docs/research/profile-coverage.md.
 */
import { cited as c } from '../cited';
import type { Profile } from '../profile';

export const current: Profile = {
  id: 'current',
  label: 'AOS 7.6 / AHV 11.2 (current)',

  ahvHa: {
    heartbeatIntervalS: c(
      1,
      'verified',
      ['ntnx-bible-5b'],
      'Acropolis leader ↔ each host libvirtd, once per second.',
    ),
    timeoutStartS: c(
      20,
      'verified',
      ['ntnx-bible-5b'],
      'T+20: the 40 s host-disconnect timeout starts.',
    ),
    disconnectTimeoutS: c(
      40,
      'verified',
      ['ntnx-bible-5b', 'ntnx-ahv-admin-11.2'],
      'Host disconnected for 40 s → its VMs restart, subject to resources.',
    ),
    fenceAtS: c(60, 'verified', ['ntnx-bible-5b'], 'T+60: Stargates block IO from the lost host.'),
    restartByS: c(120, 'verified', ['ntnx-bible-5b'], 'VMs restart within 120 s.'),
    isolatedVmSelfTerminateS: c(
      45,
      'verified',
      ['ntnx-bible-5b'],
      'VMs on a partitioned host fail 45 s after their first IO failure.',
    ),
    leaderReelectionS: c(
      20,
      'verified',
      ['ntnx-bible-5b'],
      'Surviving hosts elect a new Acropolis leader at T+20.',
    ),
    vswitchQuickUpdateHaTriggerS: c(
      30,
      'verified',
      ['ntnx-ahv-admin-11.2'],
      'Virtual switch quick update > 30 s triggers HA (> 20 s may restart AOS services).',
    ),
    forceShutdownRestartCycles: c(
      1,
      'assumption',
      ['ntnx-ncp-everpure-deploy-7.6'],
      'SPEC §14 #7: restarted through AHV HA at the next HA cycle (one heartbeat interval).',
    ),
  },

  redirector: {
    nopIntervalS: c(
      1,
      'inferred',
      ['ntnx-bible-5b'],
      'Bible: the redirector "regularly" NOPs Stargates; ~1 s cadence inferred, interval not published.',
    ),
    missesToUnhealthy: c(
      2,
      'inferred',
      ['ntnx-blog-cvm-failure', 'ntnx-bible-5b'],
      'Autopath rule "fails to respond two or more times in a 30-second period", applied to the AHV redirector.',
    ),
    missWindowS: c(
      30,
      'inferred',
      ['ntnx-blog-cvm-failure', 'ntnx-bible-5b'],
      'Window for the two-miss rule.',
    ),
    failbackStableS: c(
      30,
      'inferred',
      ['ntnx-blog-cvm-failure', 'ntnx-bible-5b'],
      'Path not restored until the local CVM has been stable ≥ 30 s.',
    ),
    redirectStallS: c(
      3,
      'assumption',
      ['ntnx-bible-5b'],
      'No published AHV figure. Extra IO pause while QEMU re-logs in to the remote Stargate after the redirect decision; lab L3.',
    ),
  },

  cluster: {
    zkMembersFt1: c(
      3,
      'unverified',
      ['ntnx-community-cvm-components', 'ntnx-bible-4i'],
      'Community copy of the Bible: ZK "runs on three or five nodes, depending on the redundancy factor".',
    ),
    zkMembersFt2: c(
      5,
      'unverified',
      ['ntnx-community-cvm-components', 'ntnx-bible-4i'],
      'As above; FT2 (metadata RF5) needs ≥ 5 nodes (Bible 4i).',
    ),
    cassandraRingDetachS: c(
      1800,
      'verified',
      ['ntnx-bible-4i', 'ntnx-kb-1256'],
      'A node down for 30 min is removed from the metadata ring; re-added after it is stable.',
    ),
    minNodes: c(3, 'verified', ['ntnx-bible-4i'], 'FT1 without erasure coding; FT2 needs 5.'),
    cvmBootS: c(
      180,
      'assumption',
      [],
      'No published figure. Model value for CVM power-on to Stargate serving; replace from lab testing.',
    ),
    cassandraRejoinStableS: c(
      600,
      'assumption',
      ['ntnx-bible-4i', 'ntnx-kb-1256'],
      'Auto ring-repair re-adds a detached node after it has been stable for an unspecified time.',
    ),
    hostRebootS: c(
      300,
      'assumption',
      [],
      'No published figure; server POST + AHV boot takes minutes. Long enough that HA fences and restarts the VMs (as for a power loss).',
    ),
  },

  hci: {
    rebuildStartDelayS: c(
      0,
      'verified',
      ['ntnx-bible-4i'],
      'Rebuild begins immediately on an unplanned failure.',
    ),
    curatorPartialScanS: c(
      3600,
      'unverified',
      ['ntnx-community-cvm-components'],
      'Partial scan "every hour".',
    ),
    curatorFullScanS: c(
      21600,
      'unverified',
      ['ntnx-community-cvm-components'],
      'Full scan "around every 6 hours".',
    ),
    diskOfflineEventsPerHourToStayOffline: c(
      3,
      'verified',
      ['ntnx-bible-4i'],
      'Marked offline 3 times in an hour → Hades stops returning the disk to service.',
    ),
    readOnlyCapacityPct: c(95, 'verified', ['ntnx-bible-4i'], 'Stargate goes read-only at 95 %.'),
    capacityWarnPct: c(
      75,
      'verified',
      ['ntnx-bible-4i'],
      'Default Prism warning threshold, as % of resilient capacity.',
    ),
    vdiskOwnerMigrationRemoteIoS: c(
      300,
      'verified',
      ['ntnx-bible-4a'],
      'Stargate relinquishes the vDisk token after 300+ s of remote IO.',
    ),
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
      ['ntnx-bible-4i', 'ntnx-community-rebuild-rate'],
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
  },

  bond: {
    lacpFastDetectS: c(3, 'verified', ['ntnx-ahv-admin-11.2']),
    lacpSlowDetectS: c(90, 'verified', ['ntnx-ahv-admin-11.2']),
    slbRebalanceIntervalS: c(
      10,
      'assumption',
      ['ovs-bonding', 'ovs-vswitchd-conf'],
      'OVS default ("Every 10 seconds, vswitchd rebalances"); whether AHV tunes bond-rebalance-interval is not published.',
    ),
  },

  externalStorage: {
    vdiskVolumeMapping: c(
      '1:1',
      'verified',
      ['ntnx-ncp-everpure-deploy-7.6', 'everpure-nutanix-rn'],
      'Every vDisk is one FA volume, no metadata/CBT volume. Requires AOS 7.6 with Purity//FA 6.11.8+ or 6.12.0+.',
    ),
    maxVdisksPerCluster: c(10000, 'verified', [
      'ntnx-ncp-everpure-deploy-7.6',
      'everpure-nutanix-req',
    ]),
    minNodes: c(
      3,
      'verified',
      ['ntnx-ncp-everpure-deploy-7.6', 'everpure-nutanix-req'],
      'Supported size is 3–32 nodes.',
    ),
    nodeFailureTolerance: c(
      { belowFiveNodes: 2, fiveOrMore: 3 },
      'verified',
      ['ntnx-ncp-everpure-deploy-7.6'],
      'Tolerated simultaneous failures = N − value: N−2 below 5 nodes, N−3 at 5 or more.',
    ),
    pathLossDefault: c(
      'retry-until-array-responds',
      'verified',
      ['ntnx-ncp-everpure-deploy-7.6'],
      'Optional per-VM force-shutdown timeout restarts the VM on a node with array connectivity.',
    ),
    multipathPolicy: c(
      'active-active',
      'assumption',
      ['spdk-nvme-multipath', 'ntnx-bible-8c'],
      'Policy Nutanix configures is not public. SPDK supports both; round-robin active-active chosen; lab L12.',
    ),
    ioQueuesPerPath: c(
      4,
      'assumption',
      ['nvme-tcp-spec', 'spdk-jsonrpc'],
      'One TCP connection per NVMe/TCP queue (spec). Integration value not public; 4 is a model abstraction; lab L12.',
    ),
    keepAliveTimeoutS: c(
      5,
      'verified',
      ['everpure-nutanix-301-deck', 'nvme-base-spec'],
      'Set automatically by the integration; must not be changed. Keep Alive is sent every KATO/2 (NVMe spec).',
    ),
    commandQuiesceTimeS: c(
      30,
      'verified',
      ['everpure-nutanix-301-deck', 'nvme-base-spec'],
      'Set automatically by the integration. In-flight commands on a lost path are held CQT before retry on another path (TP4129).',
    ),
    reconnectDelayS: c(
      20,
      'assumption',
      ['spdk-nvme-multipath'],
      'reconnect_delay_sec from the SPDK multipath example. Integration value not public; lab L5.',
    ),
    controllerLossTimeoutS: c(
      3600,
      'verified',
      ['everpure-nutanix-301-deck'],
      'Set automatically by the integration; long enough to ride out FA controller reboots (e.g. NDU with firmware). Until it expires, IO retries (DEPLOY-GUIDE "retries I/O until the array responds").',
    ),
    ioTimeoutS: c(
      30,
      'assumption',
      [],
      'Integration value not public. 30 s mirrors the common Linux NVMe io_timeout default; replace from lab testing.',
    ),
  },

  flasharray: {
    claimExpiryDetectS: c(
      1,
      'verified',
      ['everpure-ha-crash'],
      'Secondary detects expired drive-quorum claims in about 1 s.',
    ),
    primaryCrashPauseS: c(
      16,
      'verified',
      ['everpure-ha-crash'],
      'No array IO for a few seconds up to ~16 s; the model uses the documented upper bound.',
    ),
    promotionMaxS: c(15, 'verified', ['everpure-ha-timing']),
    ioDelayTimeoutS: c(
      15,
      'verified',
      ['everpure-ha-iodelay'],
      'Primary IO stall → giveback after 15 s, then promotion.',
    ),
    failoverObjectiveS: c(
      30,
      'verified',
      ['everpure-ha-timing'],
      'Design objective for a complete failover.',
    ),
    plannedFailoverPauseS: c(15, 'verified', ['everpure-ha-planned', 'everpure-upgrade']),
    hostMultipathRetryS: c(
      10,
      'inferred',
      ['everpure-ha-scenarios'],
      'Documented for generic hosts; applied to the CVM SPDK initiator by inference.',
    ),
    worstCaseSingleIoS: c(60, 'verified', ['everpure-host-timeouts']),
    controllerRebootS: c(
      300,
      'assumption',
      ['everpure-upgrade'],
      'Model value for one controller reboot during NDU (minutes; longer with firmware updates). Replace from lab testing.',
    ),
    serviceTimeMs: c(
      { read: 0.2, write: 0.15 },
      'assumption',
      [],
      'Illustrative array service time for displayed latency only; never drives timing. Replace from lab measurements.',
    ),
  },

  guest: {
    linuxScsiTimeoutS: c(
      60,
      'verified',
      ['ntnx-ahv-admin-11.2'],
      'Recommended Linux guest SCSI device timeout.',
    ),
  },
};
