/**
 * Behavior profile for the current release: AOS 7.6 / AHV 11.2, with Purity//FA 6.11.8+ or 6.12.x
 * for external storage. Audit table: docs/research/profile-coverage.md.
 */
import { cited as c, RECONNECT_FOREVER } from '../cited';
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
      10,
      'assumption',
      ['spdk-jsonrpc'],
      'SPDK bdev_nvme default keep_alive_timeout_ms (10 s). Integration value not public; lab L5.',
    ),
    commandQuiesceTimeS: c(
      0,
      'assumption',
      ['nvme-base-spec'],
      'Integration value not public. 0 = controller advertises no CQT (Linux nvmet default), so in-flight IO is retried right after the path is declared lost. Owner/lab to confirm (L5).',
    ),
    reconnectDelayS: c(
      20,
      'assumption',
      ['spdk-nvme-multipath'],
      'reconnect_delay_sec from the SPDK multipath example. Integration value not public; lab L5.',
    ),
    controllerLossTimeoutS: c(
      RECONNECT_FOREVER,
      'assumption',
      ['spdk-nvme-multipath', 'spdk-jsonrpc', 'ntnx-ncp-everpure-deploy-7.6'],
      '-1 = reconnect forever (SPDK semantics, as in its multipath example); matches the documented retry-until-array-responds default.',
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
