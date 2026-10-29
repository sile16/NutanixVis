# Profile coverage: `current` (AOS 7.6 / AHV 11.2, Purity//FA 6.11.8+ / 6.12.x)

This is the audit view of `src/domain/versions/profiles/current.ts`: every field, its value, its confidence label (SPEC §2) and the citation ids from `src/domain/citations.ts`.

- **The table is generated.** `tests/versions/coverage-doc.test.ts` fails when it drifts from the profile. To regenerate it, run `UPDATE_COVERAGE=1 npx vitest run tests/versions/coverage-doc.test.ts`.
- **Units.** Fields ending in `S` are simulated seconds, and `Pct` fields are percentages.
- **Checked on 2026-10-27.** See "Verification log" below for what was re-checked and what could not be reached.

## Summary and fields

<!-- coverage:begin -->
| Confidence | Count |
|---|---|
| verified | 39 |
| inferred | 16 |
| unverified | 1 |
| assumption | 25 |
| lab-observed | 0 |
| **Total** | **81** |

| Field | Value | Confidence | Citations | Note |
|---|---|---|---|---|
| `ahvHa.heartbeatIntervalS` | 1 | verified | `ntnx-bible-5b` | Acropolis leader ↔ each host libvirtd, once per second. |
| `ahvHa.timeoutStartS` | 20 | verified | `ntnx-bible-5b` | T+20: the 40 s host-disconnect timeout starts. |
| `ahvHa.disconnectTimeoutS` | 40 | verified | `ntnx-bible-5b`, `ntnx-ahv-admin-11.2` | Host disconnected for 40 s → its VMs restart, subject to resources. |
| `ahvHa.fenceAtS` | 60 | verified | `ntnx-bible-5b` | T+60: Stargates block IO from the lost host. |
| `ahvHa.restartByS` | 120 | verified | `ntnx-bible-5b` | VMs restart within 120 s. |
| `ahvHa.isolatedVmSelfTerminateS` | 45 | verified | `ntnx-bible-5b` | VMs on a partitioned host fail 45 s after their first IO failure. |
| `ahvHa.leaderReelectionS` | 20 | verified | `ntnx-bible-5b` | Surviving hosts elect a new Acropolis leader at T+20. |
| `ahvHa.vswitchQuickUpdateHaTriggerS` | 30 | verified | `ntnx-ahv-admin-11.2` | Virtual switch quick update > 30 s triggers HA (> 20 s may restart AOS services). |
| `ahvHa.forceShutdownRestartCycles` | 1 | assumption | `ntnx-ncp-everpure-deploy-7.6` | SPEC §14 #7: restarted through AHV HA at the next HA cycle (one heartbeat interval). |
| `ahvHa.selfTerminateWithoutQuorum` | true | inferred | `ntnx-bible-5b`, `reddit-nutanix-all-nodes-network-loss` | HCI only. Bible 5b ties the 45 s self-termination to IO failure, not to a quorum side existing; a field report on a total partition says VMs "fence" and the cluster returns to its previous state once the network is back (anecdotal). T1 keeps retrying IO (DEPLOY-GUIDE). |
| `redirector.nopIntervalS` | 1 | inferred | `ntnx-bible-5b` | Not published. The Bible says the redirector "regularly" NOPs Stargates; the ~1 s cadence is inferred from the Bible's redirector log sample. |
| `redirector.missesToUnhealthy` | 2 | assumption | `ntnx-blog-cvm-failure`, `ntnx-bible-5b` | Hypervisor-agnostic Autopath rule (2014): "fails to respond two or more times in a 30-second period". The AHV redirector's miss count is not published; lab L3. |
| `redirector.missWindowS` | 30 | assumption | `ntnx-blog-cvm-failure`, `ntnx-bible-5b` | Window for the two-miss rule (hypervisor-agnostic Autopath rule, 2014); AHV value not published. |
| `redirector.failbackStableS` | 300 | unverified | `odgers-ahv-io-failover-2015`, `ntnx-bible-5b` | AHV: IO returns to the local Stargate "once the local stargate is back online (and stable for 300 seconds)" (Josh Odgers, 2015). Failback is much slower than the failover. The Genesis --def_stargate_stable_interval (30 s) is a different path: when Genesis treats a Stargate as stable for HA, not the redirector's failback. |
| `redirector.redirectStallS` | 3 | assumption | `ntnx-bible-5b` | No published AHV figure. Extra IO pause while the initiator (Frodo/QEMU) re-logs in to the remote Stargate after the redirect decision; lab L3. |
| `dnd.enabled` | true | inferred | `ntnx-community-dnd`, `ntnx-cmdref-aos-7.6` | Degraded Node Detection is on by default (Nutanix community); the AOS 7.6 Command Reference lists a disable-degraded-node-monitoring command to turn it off. |
| `dnd.scoringWindowS` | 60 | assumption | `ntnx-community-dnd` | No published window. Peers score each CVM's responsiveness; a CVM that was unresponsive to them (network flaps, partial blackouts) within this window and answers again is marked Degraded at its end. |
| `dnd.autoResolveHealthyS` | 86400 | assumption | `ntnx-community-dnd` | No published figure. A Degraded node is cleared only after a long healthy observation period (here a day) or when an operator marks it fixed. |
| `cluster.zkMembersFt1` | 3 | verified | `ntnx-kb-1587`, `ntnx-bible-4i` | KB-1587: "Replication Factor of 2 (RF2) has 3 zookeeper servers running". |
| `cluster.zkMembersFt2` | 5 | verified | `ntnx-kb-1587`, `ntnx-bible-4i` | KB-1587: "Replication Factor of 3 (RF3) has 5 zookeeper servers running"; FT2 needs ≥ 5 nodes (Bible 4i). |
| `cluster.cassandraRingDetachS` | 1800 | verified | `ntnx-bible-4i`, `ntnx-kb-1256` | A node down for 30 min is removed from the metadata ring; re-added after it is stable. |
| `cluster.minNodes` | 3 | verified | `ntnx-bible-4i` | FT1 without erasure coding; FT2 needs 5. |
| `cluster.cvmBootS` | 180 | assumption | `ntnx-cmdref-aos-7.6` | No published figure for CVM power-on to Stargate serving. Upper bound: Genesis --svm_reboot_timeout = 420 s, "Maximum time expected for SVM to reboot/shutdown" (Command Ref 7.6). Hades maintenance exit uses the shorter hades.servicesRestartS. |
| `cluster.cassandraRejoinStableS` | 1800 | inferred | `ntnx-kb-1256`, `ntnx-bible-4i` | KB-1256: a detached node is "added back to the ring if the node has been stable for 30 minutes". KB text not yet confirmed on the portal. |
| `cluster.hostRebootS` | 300 | assumption |  | No published figure; server POST + AHV boot takes minutes. Long enough that HA fences and restarts the VMs (as for a power loss). |
| `cluster.zkSessionTimeoutS` | 20 | inferred | `ntnx-community-zk-session`, `ntnx-cmdref-aos-7.6` | Not documented. CVM logs show the ZK client negotiating "timeout=20 secs"; Genesis --zk_initial_connection_wait_secs = 20 is "Shorter than session timeout". Delays "cluster services down" and Prism Element loss; IO effects are immediate. |
| `cluster.serviceVolumeMigrationDelayS` | 300 | inferred | `ntnx-ncp-powerstore-deploy-7.6`, `ntnx-ncp-everpure-deploy-7.6` | External storage: "If an active node fails, the cluster mounts the cluster service volumes on an inactive node after a 5-minute delay"; not during an upgrade (PowerStore guide 7.6). The FlashArray guide omits the sentence; same Hades mechanism. |
| `hades.maintenanceOnStorageError` | true | inferred | `ntnx-cmdref-aos-7.6`, `ntnx-bible-8c`, `everpure-nutanix-nci-cfg` | Service volumes are reached through the CVM kernel NVMe/TCP + dm-multipath ("Linux native multipathing"). A CVM that loses them goes into maintenance mode, so its Stargate stops and the redirector moves its VMs. Topology option hades-maintenance-on-storage-error overrides. |
| `hades.volumeMonitorIntervalS` | 5 | verified | `ntnx-cmdref-aos-7.6` | --external_storage_volume_monitor_interval_secs: "Interval in seconds to monitor the health of the external storage volume mounts." |
| `hades.externalStorageErrorThresholdS` | 5 | verified | `ntnx-cmdref-aos-7.6` | --external_storage_monitor_error_threshold_secs: "Threshold in seconds to consider an external storage error as critical and put the node in maintenance mode." |
| `hades.mapNvmfVolumesIntervalS` | 300 | verified | `ntnx-cmdref-aos-7.6` | --external_storage_map_nvmf_volumes_interval_secs: "Interval in seconds to connect all NVMf storage volumes to the CVM." It re-connects volumes that are not connected; controllers that reconnected on their own do not wait for it, and a node leaves maintenance at the next volume check that finds its mounts healthy. |
| `hades.servicesRestartS` | 60 | assumption | `ntnx-cmdref-aos-7.6` | No published figure. After Hades takes the node out of maintenance the CVM services (Stargate, Zookeeper, Cassandra) start again: on the order of a minute, shorter than a full CVM boot (cluster.cvmBootS). The redirector then fails back only after its 300 s stable window. |
| `hci.rebuildStartDelayS` | 60 | inferred | `ntnx-bible-4i`, `ntnx-kb-delayed-rebuild`, `ntnx-kb-slow-rebuild-ec` | Counted from when the Stargate is declared down. Bible 4i "immediately" means no long repair-delay timer; the KBs give a selective Curator scan / rebuild 60 s after Stargate is down. KB text not yet confirmed on the portal. |
| `hci.curatorPartialScanS` | 3600 | inferred | `ntnx-kb-2101`, `ntnx-community-curator-scans`, `ntnx-community-cvm-components`, `ntnx-community-free-space` | Partial scan about 1 h after the last one (three Nutanix-staff community posts agree; KB-2101 by title, KB text not yet confirmed on the portal). |
| `hci.curatorFullScanS` | 21600 | inferred | `ntnx-kb-2101`, `ntnx-community-curator-scans`, `ntnx-community-cvm-components` | Full scan about 6 h after the last one (Nutanix-staff community posts; KB-2101 by title, KB text not yet confirmed on the portal). |
| `hci.diskOfflineEventsPerHourToStayOffline` | 3 | verified | `ntnx-bible-4i` | Marked offline 3 times in an hour → Hades stops returning the disk to service. |
| `hci.readOnlyCapacityPct` | 95 | verified | `ntnx-bible-4i` | Stargate goes read-only at 95 %. |
| `hci.capacityWarnPct` | 75 | verified | `ntnx-bible-4i` | Default Prism warning threshold, as % of resilient capacity. |
| `hci.vdiskOwnerMigrationRemoteIoS` | 300 | verified | `ntnx-bible-4a` | Stargate relinquishes the vDisk token after 300+ s of remote IO. |
| `hci.extentGroupsPerVdisk` | 8 | assumption | `ntnx-bible-4g` | Model granularity (SPEC §6.3 default). Real extent groups are 4 MiB (1 MiB with dedup), Bible 4g, so a vDisk has thousands. |
| `hci.rebuildGiBpsPerNode` | 0.5 | assumption | `ntnx-bible-4i`, `ntnx-community-rebuild-rate`, `ntnx-community-rebuild-rate-rf3`, `ntnx-kb-slow-rebuild-ec` | No published per-node figure. Public 2018 lab tests (Josh Odgers, parts 1 and 3) work out to about 0.3–0.6 GB/s per surviving node; an all-flash node rebuild is "expected 1 to 2 hours" (KB, text not yet confirmed on the portal). Anecdotal. |
| `hci.initialUsedCapacityPct` | 20 | assumption |  | Illustrative starting fill. Drives replica size, hence rebuild duration. |
| `hci.diskSmartCheckS` | 120 | assumption | `ntnx-bible-4i`, `ntnx-kb-hades`, `smartctl-man` | No published duration. Hades runs a smartctl short self-test, which takes a minute or two. |
| `hci.replicaAckTimeoutS` | 2 | assumption |  | No published Stargate RPC timeout. Applies to a dropped replica write whose peer is still up. A silent peer (power loss, hang, isolation) is handled by `stargateDownDetectS` (up to 20 s). |
| `hci.stargateDownDetectS` | 20 | inferred | `ntnx-kb-io-freeze-cvm-down` | KB: on a node hang or unexpected reboot "it could take up to 20 seconds for Zookeeper to determine that Stargate is down", with a noticeable IO stoppage. KB text not yet confirmed on the portal. |
| `hci.stargateStopDetectS` | 1 | inferred | `ntnx-kb-io-freeze-cvm-down` | KB: when Stargate stops, the IO pause is "~1 second or potentially less". KB text not yet confirmed on the portal. |
| `hci.diskOfflineWindowS` | 3600 | verified | `ntnx-bible-4i` | "3 times within an hour". |
| `bond.lacpFastDetectS` | 3 | verified | `ntnx-ahv-admin-11.2`, `ovs-lacp-source` | Prism Active-Active always sets the fast rate (one LACPDU per second, timeout 3 × that). Liveness is LACPDU receipt only, so a switch that hangs but keeps sending LACPDUs is never detected. |
| `bond.lacpSlowDetectS` | 90 | verified | `ntnx-ahv-admin-11.2`, `ovs-vswitchd-conf` | Host-side slow rate, which can only be set outside Prism (manage_ovs or the AHV installer). A slow rate on the switch only slows the switch side; the host still detects in 3 s (inferred). |
| `bond.slbRebalanceIntervalS` | 10 | assumption | `ovs-bonding`, `ovs-vswitchd-conf`, `ntnx-community-slb-rebalance` | OVS default ("Every 10 seconds, vswitchd rebalances"); whether AHV tunes bond-rebalance-interval is not published. A Nutanix technical marketing post (2020) recommends 30 s. |
| `bond.lacpFallbackAb` | true | verified | `ntnx-ahv-admin-11.2`, `ovs-lacp-source` | Prism Active-Active sets LACP fallback to active-backup on every host, and it cannot be changed afterwards. A timed-out member is detached while another is negotiated; with none negotiated the bond runs active-backup. |
| `externalStorage.vdiskVolumeMapping` | '1:1' | verified | `ntnx-ncp-everpure-deploy-7.6`, `everpure-nutanix-rn` | Every vDisk is one FA volume, no metadata/CBT volume. Requires AOS 7.6 with Purity//FA 6.11.8+ or 6.12.0+. |
| `externalStorage.maxVdisksPerCluster` | 10000 | verified | `ntnx-ncp-everpure-deploy-7.6`, `everpure-nutanix-req` |  |
| `externalStorage.minNodes` | 3 | verified | `ntnx-ncp-everpure-deploy-7.6`, `everpure-nutanix-req` | Supported size is 3–32 nodes. |
| `externalStorage.nodeFailureTolerance` | { belowFiveNodes: 2, fiveOrMore: 3 } | verified | `ntnx-ncp-everpure-deploy-7.6` | Tolerated simultaneous failures = N − value: N−2 below 5 nodes, N−3 at 5 or more. |
| `externalStorage.pathLossDefault` | 'retry-until-array-responds' | verified | `ntnx-ncp-everpure-deploy-7.6` | Optional per-VM force-shutdown timeout restarts the VM on a node with array connectivity. |
| `externalStorage.multipathPolicy` | 'active-active' | assumption | `spdk-nvme-multipath`, `ntnx-bible-8c` | Policy Nutanix configures for Stargate is not public. SPDK supports both; active-active over every ANA Optimized path chosen; the path selector is `pathSelector`; lab L12. |
| `externalStorage.pathSelector` | 'queue-depth' | inferred | `everpure-linux-dm-multipath`, `everpure-nvme-tcp-bp`, `spdk-bdev-nvme-src` | Stargate selector not public. Everpure Linux guidance for FlashArray NVMe devices is queue-length based (dm-multipath queue-length; NVMe/TCP BP "Queue Length Based"); SPDK offers round_robin and queue_depth. Topology option `nvme-path-selector`; lab L12. |
| `externalStorage.ioQueuesPerPath` | 4 | inferred | `ntnx-cmdref-aos-7.6`, `nvme-tcp-spec` | AOS 7.6 Hades gflag --nvme_num_io_queues defaults to 4 IO queues per controller (the CVM kernel stack). One TCP connection per NVMe/TCP queue (spec). The Stargate count is not public; lab L12. |
| `externalStorage.keepAliveTimeoutS` | 5 | verified | `everpure-nutanix-nci-cfg`, `everpure-nutanix-301-deck`, `nvme-base-spec-2.1` | Set automatically by the integration; must not be changed. Keep Alive is sent every KATO/2. The spec allows detection between KATO and 1.5 × KATO; the model declares a silent path lost at KATO. |
| `externalStorage.commandQuiesceTimeS` | 30 | verified | `everpure-nutanix-nci-cfg`, `everpure-nutanix-301-deck`, `nvme-base-spec-2.1` | NTNX CQT, set automatically by the integration. In-flight commands on a lost path wait CQT after the loss-detection wait before retry on another path (NVMe 2.1 §9.6.3). |
| `externalStorage.lostPathHoldKatoMultiplier` | 3 | assumption | `nvme-base-spec-2.1` | Conservative traffic-based-keep-alive case of NVMe 2.1 §9.6.2 (2 × KATT with command-based keep-alive); which mode the array uses is not published. Retry at 3 × KATO + CQT ≈ 45 s after the last exchange. The spec lets reads retry at detection; the model holds all in-flight IO (conservative default). |
| `externalStorage.reconnectDelayS` | 10 | assumption | `linux-nvme-host`, `spdk-nvme-multipath` | Integration value not public. Linux NVMF_DEF_RECONNECT_DELAY (10 s), as used by the CVM kernel initiator; SPDK has no default (its multipath example uses 20 s); lab L5. |
| `externalStorage.controllerLossTimeoutS` | 3600 | verified | `everpure-nutanix-nci-cfg`, `ntnx-cmdref-aos-7.6`, `everpure-nutanix-301-deck` | Set automatically by the integration (Hades gflag --nvme_ctrl_loss_tmo 3600); long enough to ride out FA controller reboots (e.g. NDU with firmware). Until it expires, IO retries (DEPLOY-GUIDE "retries I/O until the array responds"). |
| `externalStorage.ioTimeoutS` | 45 | inferred | `nvme-base-spec-2.1`, `everpure-nutanix-nci-cfg` | Integration value not public. NVMe 2.1 §9.6 derivation 3 × KATO + CQT applied to the published timers: must be ≥ the lost-path hold, or IO could be retried while still in flight. An IO timeout resets the path (the host tears the association down and reconnects); lab L5. |
| `externalStorage.tcpRtoMaxS` | 32 | assumption | `rfc-6298`, `linux-nvme-host` | TCP doubles its retransmission timer on each retransmission of the same segment (RFC 6298 §5.5). With 1 s ticks the sub-second first retries fold into 1, 1, 1 s, then 2, 4, 8, 16, 32 s. A frame lost repeatedly on a lossy link therefore waits longer and longer, until the NVMe IO timeout aborts it. |
| `externalStorage.targetResetRetryS` | 0 | assumption | `nvme-base-spec-2.1`, `nvme-tcp-spec` | The NVMe 2.1 §9.6 wait gives the controller time to notice the loss and quiesce. A TCP reset from a target that has already torn the association down (its port lost link, or KATO passed without traffic) shows it no longer holds the commands, so they are retried at once. |
| `externalStorage.vdiskHandoverS` | 1 | assumption | `ntnx-bible-8c`, `ntnx-bible-5b` | No published figure. Once the redirector has moved the session, the remote Stargate takes the vDisk over (ownership and NVMe reservation, Bible 8c) from the CVM in Hades maintenance and serves its IO: about immediate on a healthy cluster. A long delay comes only from a redirect target that is itself unhealthy or degraded, which this field does not model. |
| `externalStorage.wholeArrayLossVmBehavior` | 'crash-and-restart' | assumption | `ntnx-ncp-everpure-deploy-7.6`, `ntnx-bible-5b` | The deployment guide says IO retries until the array responds, which bounds nothing on the guest side. Once a VM's IO has been stalled past guest.ioStallCrashS it crashes (QEMU exits), and AHV HA restarts it after the array returns. Topology option whole-array-loss-vm-behavior: stall keeps the retry-in-place picture. |
| `flasharray.claimExpiryDetectS` | 1 | verified | `everpure-ha-crash` | Secondary detects expired drive-quorum claims in about 1 s. |
| `flasharray.primaryCrashPauseS` | 16 | verified | `everpure-ha-crash` | No array IO for a few seconds up to ~16 s; the model uses the documented upper bound. |
| `flasharray.promotionMaxS` | 15 | verified | `everpure-ha-timing` |  |
| `flasharray.ioDelayTimeoutS` | 15 | verified | `everpure-ha-iodelay` | Primary IO stall → giveback after 15 s, then promotion. |
| `flasharray.failoverObjectiveS` | 30 | verified | `everpure-ha-timing` | Design objective for a complete failover. |
| `flasharray.plannedFailoverPauseS` | 15 | verified | `everpure-ha-planned`, `everpure-upgrade` |  |
| `flasharray.hostMultipathRetryS` | 10 | inferred | `everpure-ha-scenarios`, `everpure-linux-dm-multipath` | Generic SCSI / dm-multipath hosts (fast_io_fail_tmo 10). Not the Stargate NVMe/TCP path, which detects loss by keep-alive (KATO) and holds in-flight IO (SPEC §6.4c). Informational; no model timing uses it. |
| `flasharray.worstCaseSingleIoS` | 60 | verified | `everpure-host-timeouts` |  |
| `flasharray.controllerRebootS` | 300 | assumption | `everpure-upgrade` | Model value for one controller reboot during NDU (minutes; longer with firmware updates). Replace from lab testing. |
| `flasharray.serviceTimeMs` | { read: 0.2, write: 0.15 } | assumption |  | Illustrative array service time for displayed latency only; never drives timing. Replace from lab measurements. |
| `guest.linuxScsiTimeoutS` | 60 | verified | `ntnx-ahv-admin-11.2` | Recommended Linux guest SCSI device timeout. |
| `guest.ioStallCrashS` | 180 | assumption | `ntnx-ahv-admin-11.2` | No published figure. How long a VM survives a whole-array IO stall before it crashes (QEMU exits, "VM shut down unexpectedly"): minutes, well past the guest disk timeout. |
<!-- coverage:end -->

## Assumptions and unverified values

These are the values the lab plan (`lab-validation-plan.md`) should upgrade first.

| Field | Value | Why this value | Lab |
|---|---|---|---|
| `redirector.redirectStallS` | 3 s | No AHV figure is published. A few ticks covers the initiator's (Frodo/QEMU) re-login to the remote Stargate after the redirect decision. | L3 |
| `redirector.missesToUnhealthy` / `missWindowS` | 2 / 30 s | The hypervisor-agnostic Autopath rule (2014 Nutanix blog). The AHV redirector's count is not published. | L3 |
| `bond.slbRebalanceIntervalS` | 10 s | The documented Open vSwitch default ("Every 10 seconds, vswitchd rebalances"). Whether AHV tunes `bond-rebalance-interval` is not public. | L13 |
| `externalStorage.multipathPolicy` | active-active | The policy Nutanix configures for Stargate is not public. SPDK supports active-passive and active-active. The selector (`pathSelector`, queue-depth, `inferred`) is a separate field. | L12 |
| `externalStorage.lostPathHoldKatoMultiplier` | 3 | NVMe 2.1 §9.6.2: wait 2 × KATT (command-based keep-alive) or 3 × KATT (traffic-based) before CQT. The conservative traffic-based case; which mode the array uses is not published. All in-flight IO is held, although the spec lets reads retry at detection. | L5, L12 |
| `externalStorage.reconnectDelayS` | 10 s | Linux `NVMF_DEF_RECONNECT_DELAY`, the default of the CVM's kernel initiator. SPDK has no default (its multipath example uses `-o 20`). | L5 |
| `hci.curatorPartialScanS` / `curatorFullScanS` | 3600 / 21600 s | A community post says "every hour" and "around every 6 hours". The Bible gives no schedule. | — |
| `cluster.cvmBootS` | 180 s | No published figure. Upper bound: Genesis `--svm_reboot_timeout` = 420 s (Command Ref 7.6). Also the service restart after a Hades re-map. | L7 |

**NVMe sources.** KATO, CQT and the controller-loss timeout are published in the public Everpure KB `everpure-nutanix-nci-cfg` and the AOS 7.6 Command Reference (`ntnx-cmdref-aos-7.6`). The lost-path hold and the IO timeout follow the NVMe Base Specification 2.1 (`nvme-base-spec-2.1`). Everpure's generic Linux guidance (`everpure-linux-dm-multipath`, `everpure-nvme-tcp-bp`) informs only the path selector, as `inferred`. `flasharray.hostMultipathRetryS` is generic SCSI / dm-multipath behavior and drives no NVMe timing.

## Verification log (2026-10-27)

| Source | Status | Result |
|---|---|---|
| `ntnx-kb-1587`, `ntnx-cmdref-aos-7.6`, `ntnx-ncp-powerstore-deploy-7.6`, PE/PC alert references (2026-10-28) | Read | KB-1587: 3 ZK servers under RF2, 5 under RF3, so `zkMembersFt1/Ft2` are `verified`. Command Ref 7.6: the Hades monitor (5 s), critical-error threshold (5 s) and NVMf re-map (300 s); `--def_stargate_stable_interval` 30; `--svm_reboot_timeout` 420; `--zk_initial_connection_wait_secs` 20; two-node return gate 7 min. PowerStore guide 7.6: service volumes move off a failed active node "after a 5-minute delay". Alert texts: A1001, A1006, A1030, A3032, A111009, A1145, A130068, A200000. |
| `ntnx-ncp-everpure-deploy-7.6` (local portal copy) | Read | Confirmed N−2 / N−3, retry-until-array-responds, the per-VM force-shutdown timeout, 10,000 vDisks, 3–32 nodes, and "Every AOS vDisk is a volume on Everpure FlashArray". Table 9 requires **Purity//FA 6.11.8** for NVMe/TCP. |
| `ntnx-ncp-everpure-compat-7.6` (local portal copy) | Read | **The PDF has no table.** Page 4 only links to the portal's External Storage Compatibility Matrix (`ntnx-storage-compat-matrix`), which renders with JavaScript and could not be read. |
| `ntnx-ahv-admin-11.2` (local portal copy) | Read | Confirmed the 40 s disconnect, the vswitch quick update thresholds (> 20 s services, > 30 s HA), LACP fast 3 s / slow 90 s, and the 60 s Linux SCSI timeout. |
| `everpure-nutanix-req` | Read | Purity//FA 6.10.3+ is the integration minimum (AOS 7.5+, AHV 11.0+). 10,000 vDisks needs AOS 7.6 with Purity//FA 6.11.8+ or 6.12.0+. 3–32 nodes. ActiveCluster: co-existence only. |
| `everpure-nutanix-rn` | Read | The AOS 7.6 features (1:1 vDisk→volume with no metadata volume, 10,000 vDisks, FA async/ActiveDR/SafeMode) require Purity//FA 6.11.8 or 6.12.0. No Purity//FA line newer than 6.12 is listed. |
| `everpure-nutanix-net-bp` | Read | Confirmed MAC pinning, at least 2 storage VLANs, and MTU 9216 on the fabric / 9000 at endpoints. |
| `ntnx-bible-5b`, `-4i`, `-4a`, `-8c` | Read | Confirmed the HA timeline (1 Hz, T20/T60/T120, 45 s), the 30 min ring detach, immediate rebuild, 3 offline events per hour, 95 % read-only, the 75 % resilient-capacity warning, 300 s owner migration, and PR fencing. The Bible does not give the redirector NOP interval. |
| `ntnx-blog-cvm-failure` | Read (archived) | The live URL returns 404. The archived copy confirms the "two or more times in a 30-second period" rule and failback after "at least 30 seconds" stable. |
| `spdk-jsonrpc`, `spdk-nvme-multipath` | Read | Keep-alive default 10 s. The multipath example uses `-l -1 -o 20`, active_active / round_robin. |
| `everpure-nutanix-nci-cfg`, `everpure-nutanix-troubleshooting`, `everpure-linux-dm-multipath` (2026-10-28) | Read (public) | KATO 5 s, Controller Loss Timeout 3600 s, NTNX CQT 30 s, "Linux native multipathing". DM-multipath for FlashArray NVMe: `queue-length`, `prio ana`, `fast_io_fail_tmo 10`. |
| `ntnx-cmdref-aos-7.6` (local portal copy, 2026-10-28) | Read | Hades gflags `--nvme_ctrl_loss_tmo` 3600 and `--nvme_num_io_queues` 4. |
| `nvme-base-spec-2.1`, `spdk-bdev-nvme-src`, `linux-nvme-host` (2026-10-28) | Read | Keep-alive detection within KATT to 1.5 × KATT; §9.6 waits (2 × / 3 × KATT, then CQT); SPDK round_robin and queue_depth selectors; Linux `NVMF_DEF_RECONNECT_DELAY` 10 s and `io_timeout` 30 s. |
| `ovs-bonding`, `ovs-vswitchd-conf` | Read | The rebalance runs every 10 s by default. LACP fast is a 1 s heartbeat and slow is 30 s. |
| Everpure Purity//FA HA KBs (`everpure-ha-*`, `everpure-host-timeouts`) and `everpure-nvme-tcp-bp` | **Not reachable** (login required) | The values are kept from the earlier research pass in `nutanix-flasharray.md` §3. Re-check them with a support login. |

## Research source key → citation id

| Research key | Citation id |
|---|---|
| DEPLOY-GUIDE | `ntnx-ncp-everpure-deploy-7.6` |
| COMPAT | `ntnx-ncp-everpure-compat-7.6` (links to `ntnx-storage-compat-matrix`) |
| REQ / RN / NET / CFG / FA-REP | `everpure-nutanix-req` / `everpure-nutanix-rn` / `everpure-nutanix-net-bp` / `everpure-nutanix-cfg` / `everpure-fa-rep-nutanix` |
| HA-Explained / HA-Timing / HA-Crash / HA-Planned / HA-Secondary / HA-IODelay / HA-Scenarios | `everpure-ha-explained` / `everpure-ha-timing` / `everpure-ha-crash` / `everpure-ha-planned` / `everpure-ha-secondary` / `everpure-ha-iodelay` / `everpure-ha-scenarios` |
| HOST-TMO / ANA-FAQ / TCP-BP / NPIV / UPG | `everpure-host-timeouts` / `everpure-ana-faq` / `everpure-nvme-tcp-bp` / `everpure-npiv` / `everpure-upgrade` |
| BIBLE-AHV, BIBLE-HLD, BIBLE-ARCH | `ntnx-bible-5b`, `ntnx-bible-8b`, `ntnx-bible-8c` |
| AHV Admin Guide 11.2 | `ntnx-ahv-admin-11.2` |
| nutanix-hci.md [1] [2] [3] [4] [5] [9] [14] | `ntnx-community-cvm-components`, `ntnx-bible-4i`, `ntnx-bible-4g`, `ntnx-bible-4a`, `ntnx-bible-5b`, `ntnx-blog-cvm-failure`, `ntnx-bible-5a` |
| nutanix-hci.md [6] [11] [12] [15] [16] [17] [18] | `ntnx-community-rebuild-cvm-down`, `ntnx-community-node-detach`, `ntnx-community-dnd`, `ntnx-community-segmentation`, `ntnx-community-beyond-ft`, `ntnx-community-two-node`, `ntnx-community-two-node-failover` |
| KB-1256 | `ntnx-kb-1256` |
| CO-node community posts | `ntnx-community-co-nodes-blog`, `ntnx-community-co-nodes` |
| SPDK / OVS / NVMe | `spdk-nvme-multipath`, `spdk-jsonrpc`, `spdk-bdev-nvme-src`, `ovs-bonding`, `ovs-vswitchd-conf`, `nvme-tcp-spec`, `nvme-base-spec-2.1`, `linux-nvme-host` |
| NCI-CFG / TROUBLESHOOT / DM-MPIO / CMDREF (nutanix-flasharray.md) | `everpure-nutanix-nci-cfg` / `everpure-nutanix-troubleshooting` / `everpure-linux-dm-multipath` / `ntnx-cmdref-aos-7.6` |

Third-party blogs and the patent in `nutanix-hci.md` (joshodgers.com, derekseaman.com, patents.google.com) are background only. They are not in the registry, and no profile value depends on them.
