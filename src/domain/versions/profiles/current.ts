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
      1800,
      'inferred',
      ['ntnx-kb-1256', 'ntnx-bible-4i'],
      'KB-1256: a detached node is "added back to the ring if the node has been stable for 30 minutes". KB text not yet confirmed on the portal.',
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
      60,
      'inferred',
      ['ntnx-bible-4i', 'ntnx-kb-delayed-rebuild', 'ntnx-kb-slow-rebuild-ec'],
      'Counted from when the Stargate is declared down. Bible 4i "immediately" means no long repair-delay timer; the KBs give a selective Curator scan / rebuild 60 s after Stargate is down. KB text not yet confirmed on the portal.',
    ),
    curatorPartialScanS: c(
      3600,
      'inferred',
      [
        'ntnx-kb-2101',
        'ntnx-community-curator-scans',
        'ntnx-community-cvm-components',
        'ntnx-community-free-space',
      ],
      'Partial scan about 1 h after the last one (three Nutanix-staff community posts agree; KB-2101 by title, KB text not yet confirmed on the portal).',
    ),
    curatorFullScanS: c(
      21600,
      'inferred',
      ['ntnx-kb-2101', 'ntnx-community-curator-scans', 'ntnx-community-cvm-components'],
      'Full scan about 6 h after the last one (Nutanix-staff community posts; KB-2101 by title, KB text not yet confirmed on the portal).',
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
      ['ntnx-bible-4g'],
      'Model granularity (SPEC §6.3 default). Real extent groups are 4 MiB (1 MiB with dedup), Bible 4g, so a vDisk has thousands.',
    ),
    /**
     * Curator re-replication throughput contributed by each surviving CVM node. The total rate is
     * this × N, so each node does ~1/N of the work (Bible 4i).
     */
    rebuildGiBpsPerNode: c(
      0.5,
      'assumption',
      [
        'ntnx-bible-4i',
        'ntnx-community-rebuild-rate',
        'ntnx-community-rebuild-rate-rf3',
        'ntnx-kb-slow-rebuild-ec',
      ],
      'No published per-node figure. Public 2018 lab tests (Josh Odgers, parts 1 and 3) work out to about 0.3–0.6 GB/s per surviving node; an all-flash node rebuild is "expected 1 to 2 hours" (KB, text not yet confirmed on the portal). Anecdotal.',
    ),
    /** Physical used capacity (replicas included) as % of raw, at t=0. Runtime: `hci.set-capacity`. */
    initialUsedCapacityPct: c(
      20,
      'assumption',
      [],
      'Illustrative starting fill. Drives replica size, hence rebuild duration.',
    ),
    /** Hades SMART test duration once a disk's fault clears. */
    diskSmartCheckS: c(
      120,
      'assumption',
      ['ntnx-bible-4i', 'ntnx-kb-hades', 'smartctl-man'],
      'No published duration. Hades runs a smartctl short self-test, which takes a minute or two.',
    ),
    /** Stargate replication / remote-read RPC: no ack within this → replica treated as unreachable. */
    replicaAckTimeoutS: c(
      2,
      'assumption',
      [],
      'No published Stargate RPC timeout. Applies to a dropped replica write whose peer is still up. A silent peer (power loss, hang, isolation) is handled by `stargateDownDetectS` (up to 20 s).',
    ),
    /** Silent peer Stargate → declared down when its ZK session expires (writes stall meanwhile). */
    stargateDownDetectS: c(
      20,
      'inferred',
      ['ntnx-kb-io-freeze-cvm-down'],
      'KB: on a node hang or unexpected reboot "it could take up to 20 seconds for Zookeeper to determine that Stargate is down", with a noticeable IO stoppage. KB text not yet confirmed on the portal.',
    ),
    /** Cleanly stopped Stargate (process stop) → its ZK session closes at once. */
    stargateStopDetectS: c(
      1,
      'inferred',
      ['ntnx-kb-io-freeze-cvm-down'],
      'KB: when Stargate stops, the IO pause is "~1 second or potentially less". KB text not yet confirmed on the portal.',
    ),
    /** Window for `diskOfflineEventsPerHourToStayOffline` (the rule is "per hour"). */
    diskOfflineWindowS: c(3600, 'verified', ['ntnx-bible-4i'], '"3 times within an hour".'),
  },

  bond: {
    lacpFastDetectS: c(
      3,
      'verified',
      ['ntnx-ahv-admin-11.2', 'ovs-lacp-source'],
      'Prism Active-Active always sets the fast rate (one LACPDU per second, timeout 3 × that). Liveness is LACPDU receipt only, so a switch that hangs but keeps sending LACPDUs is never detected.',
    ),
    lacpSlowDetectS: c(
      90,
      'verified',
      ['ntnx-ahv-admin-11.2', 'ovs-vswitchd-conf'],
      'Host-side slow rate, which can only be set outside Prism (manage_ovs or the AHV installer). A slow rate on the switch only slows the switch side; the host still detects in 3 s (inferred).',
    ),
    slbRebalanceIntervalS: c(
      10,
      'assumption',
      ['ovs-bonding', 'ovs-vswitchd-conf', 'ntnx-community-slb-rebalance'],
      'OVS default ("Every 10 seconds, vswitchd rebalances"); whether AHV tunes bond-rebalance-interval is not published. A Nutanix technical marketing post (2020) recommends 30 s.',
    ),
    lacpFallbackAb: c(
      true,
      'verified',
      ['ntnx-ahv-admin-11.2', 'ovs-lacp-source'],
      'Prism Active-Active sets LACP fallback to active-backup on every host, and it cannot be changed afterwards. A timed-out member is detached while another is negotiated; with none negotiated the bond runs active-backup.',
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
      'Policy Nutanix configures for Stargate is not public. SPDK supports both; active-active over every ANA Optimized path chosen; the path selector is `pathSelector`; lab L12.',
    ),
    pathSelector: c(
      'queue-depth',
      'inferred',
      ['everpure-linux-dm-multipath', 'everpure-nvme-tcp-bp', 'spdk-bdev-nvme-src'],
      'Stargate selector not public. Everpure Linux guidance for FlashArray NVMe devices is queue-length based (dm-multipath queue-length; NVMe/TCP BP "Queue Length Based"); SPDK offers round_robin and queue_depth. Topology option `nvme-path-selector`; lab L12.',
    ),
    ioQueuesPerPath: c(
      4,
      'inferred',
      ['ntnx-cmdref-aos-7.6', 'nvme-tcp-spec'],
      'AOS 7.6 Hades gflag --nvme_num_io_queues defaults to 4 IO queues per controller (the CVM kernel stack). One TCP connection per NVMe/TCP queue (spec). The Stargate count is not public; lab L12.',
    ),
    keepAliveTimeoutS: c(
      5,
      'verified',
      ['everpure-nutanix-nci-cfg', 'everpure-nutanix-301-deck', 'nvme-base-spec-2.1'],
      'Set automatically by the integration; must not be changed. Keep Alive is sent every KATO/2. The spec allows detection between KATO and 1.5 × KATO; the model declares a silent path lost at KATO.',
    ),
    commandQuiesceTimeS: c(
      30,
      'verified',
      ['everpure-nutanix-nci-cfg', 'everpure-nutanix-301-deck', 'nvme-base-spec-2.1'],
      'NTNX CQT, set automatically by the integration. In-flight commands on a lost path wait CQT after the loss-detection wait before retry on another path (NVMe 2.1 §9.6.3).',
    ),
    lostPathHoldKatoMultiplier: c(
      3,
      'assumption',
      ['nvme-base-spec-2.1'],
      'Conservative traffic-based-keep-alive case of NVMe 2.1 §9.6.2 (2 × KATT with command-based keep-alive); which mode the array uses is not published. Retry at 3 × KATO + CQT ≈ 45 s after the last exchange. The spec lets reads retry at detection; the model holds all in-flight IO (conservative default).',
    ),
    reconnectDelayS: c(
      10,
      'assumption',
      ['linux-nvme-host', 'spdk-nvme-multipath'],
      'Integration value not public. Linux NVMF_DEF_RECONNECT_DELAY (10 s), as used by the CVM kernel initiator; SPDK has no default (its multipath example uses 20 s); lab L5.',
    ),
    controllerLossTimeoutS: c(
      3600,
      'verified',
      ['everpure-nutanix-nci-cfg', 'ntnx-cmdref-aos-7.6', 'everpure-nutanix-301-deck'],
      'Set automatically by the integration (Hades gflag --nvme_ctrl_loss_tmo 3600); long enough to ride out FA controller reboots (e.g. NDU with firmware). Until it expires, IO retries (DEPLOY-GUIDE "retries I/O until the array responds").',
    ),
    ioTimeoutS: c(
      45,
      'inferred',
      ['nvme-base-spec-2.1', 'everpure-nutanix-nci-cfg'],
      'Integration value not public. NVMe 2.1 §9.6 derivation 3 × KATO + CQT applied to the published timers: must be ≥ the lost-path hold, or IO could be retried while still in flight; lab L5.',
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
      ['everpure-ha-scenarios', 'everpure-linux-dm-multipath'],
      'Generic SCSI / dm-multipath hosts (fast_io_fail_tmo 10). Not the Stargate NVMe/TCP path, which detects loss by keep-alive (KATO) and holds in-flight IO (SPEC §6.4c). Informational; no model timing uses it.',
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
