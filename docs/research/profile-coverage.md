# Profile coverage: `current` (AOS 7.6 / AHV 11.2, Purity//FA 6.11.8+ / 6.12.x)

This is the audit view of `src/domain/versions/profiles/current.ts`: every field, its value, its confidence label (SPEC §2) and the citation ids from `src/domain/citations.ts`.

- **The table is generated.** `tests/versions/coverage-doc.test.ts` fails when it drifts from the profile. To regenerate it, run `UPDATE_COVERAGE=1 npx vitest run tests/versions/coverage-doc.test.ts`.
- **Units.** Fields ending in `S` are simulated seconds, and `Pct` fields are percentages.
- **Checked on 2026-10-27.** See "Verification log" below for what was re-checked and what could not be reached.

## Summary and fields

<!-- coverage:begin -->
| Confidence | Count |
|---|---|
| verified | 33 |
| inferred | 11 |
| unverified | 2 |
| assumption | 16 |
| lab-observed | 0 |
| **Total** | **62** |

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
| `redirector.nopIntervalS` | 1 | inferred | `ntnx-bible-5b` | Bible: the redirector "regularly" NOPs Stargates; ~1 s cadence inferred, interval not published. |
| `redirector.missesToUnhealthy` | 2 | inferred | `ntnx-blog-cvm-failure`, `ntnx-bible-5b` | Autopath rule "fails to respond two or more times in a 30-second period", applied to the AHV redirector. |
| `redirector.missWindowS` | 30 | inferred | `ntnx-blog-cvm-failure`, `ntnx-bible-5b` | Window for the two-miss rule. |
| `redirector.failbackStableS` | 30 | inferred | `ntnx-blog-cvm-failure`, `ntnx-bible-5b` | Path not restored until the local CVM has been stable ≥ 30 s. |
| `redirector.redirectStallS` | 3 | assumption | `ntnx-bible-5b` | No published AHV figure. Extra IO pause while QEMU re-logs in to the remote Stargate after the redirect decision; lab L3. |
| `cluster.zkMembersFt1` | 3 | unverified | `ntnx-community-cvm-components`, `ntnx-bible-4i` | Community copy of the Bible: ZK "runs on three or five nodes, depending on the redundancy factor". |
| `cluster.zkMembersFt2` | 5 | unverified | `ntnx-community-cvm-components`, `ntnx-bible-4i` | As above; FT2 (metadata RF5) needs ≥ 5 nodes (Bible 4i). |
| `cluster.cassandraRingDetachS` | 1800 | verified | `ntnx-bible-4i`, `ntnx-kb-1256` | A node down for 30 min is removed from the metadata ring; re-added after it is stable. |
| `cluster.minNodes` | 3 | verified | `ntnx-bible-4i` | FT1 without erasure coding; FT2 needs 5. |
| `cluster.cvmBootS` | 180 | assumption |  | No published figure. Model value for CVM power-on to Stargate serving; replace from lab testing. |
| `cluster.cassandraRejoinStableS` | 1800 | inferred | `ntnx-kb-1256`, `ntnx-bible-4i` | KB-1256: a detached node is "added back to the ring if the node has been stable for 30 minutes". KB text not yet confirmed on the portal. |
| `cluster.hostRebootS` | 300 | assumption |  | No published figure; server POST + AHV boot takes minutes. Long enough that HA fences and restarts the VMs (as for a power loss). |
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
| `bond.lacpFastDetectS` | 3 | verified | `ntnx-ahv-admin-11.2` |  |
| `bond.lacpSlowDetectS` | 90 | verified | `ntnx-ahv-admin-11.2` |  |
| `bond.slbRebalanceIntervalS` | 10 | assumption | `ovs-bonding`, `ovs-vswitchd-conf` | OVS default ("Every 10 seconds, vswitchd rebalances"); whether AHV tunes bond-rebalance-interval is not published. |
| `externalStorage.vdiskVolumeMapping` | '1:1' | verified | `ntnx-ncp-everpure-deploy-7.6`, `everpure-nutanix-rn` | Every vDisk is one FA volume, no metadata/CBT volume. Requires AOS 7.6 with Purity//FA 6.11.8+ or 6.12.0+. |
| `externalStorage.maxVdisksPerCluster` | 10000 | verified | `ntnx-ncp-everpure-deploy-7.6`, `everpure-nutanix-req` |  |
| `externalStorage.minNodes` | 3 | verified | `ntnx-ncp-everpure-deploy-7.6`, `everpure-nutanix-req` | Supported size is 3–32 nodes. |
| `externalStorage.nodeFailureTolerance` | { belowFiveNodes: 2, fiveOrMore: 3 } | verified | `ntnx-ncp-everpure-deploy-7.6` | Tolerated simultaneous failures = N − value: N−2 below 5 nodes, N−3 at 5 or more. |
| `externalStorage.pathLossDefault` | 'retry-until-array-responds' | verified | `ntnx-ncp-everpure-deploy-7.6` | Optional per-VM force-shutdown timeout restarts the VM on a node with array connectivity. |
| `externalStorage.multipathPolicy` | 'active-active' | assumption | `spdk-nvme-multipath`, `ntnx-bible-8c` | Policy Nutanix configures is not public. SPDK supports both; round-robin active-active chosen; lab L12. |
| `externalStorage.ioQueuesPerPath` | 4 | assumption | `nvme-tcp-spec`, `spdk-jsonrpc` | One TCP connection per NVMe/TCP queue (spec). Integration value not public; 4 is a model abstraction; lab L12. |
| `externalStorage.keepAliveTimeoutS` | 5 | verified | `everpure-nutanix-301-deck`, `nvme-base-spec` | Set automatically by the integration; must not be changed. Keep Alive is sent every KATO/2 (NVMe spec). |
| `externalStorage.commandQuiesceTimeS` | 30 | verified | `everpure-nutanix-301-deck`, `nvme-base-spec` | Set automatically by the integration. In-flight commands on a lost path are held CQT before retry on another path (TP4129). |
| `externalStorage.reconnectDelayS` | 20 | assumption | `spdk-nvme-multipath` | reconnect_delay_sec from the SPDK multipath example. Integration value not public; lab L5. |
| `externalStorage.controllerLossTimeoutS` | 3600 | verified | `everpure-nutanix-301-deck` | Set automatically by the integration; long enough to ride out FA controller reboots (e.g. NDU with firmware). Until it expires, IO retries (DEPLOY-GUIDE "retries I/O until the array responds"). |
| `externalStorage.ioTimeoutS` | 30 | assumption |  | Integration value not public. 30 s mirrors the common Linux NVMe io_timeout default; replace from lab testing. |
| `flasharray.claimExpiryDetectS` | 1 | verified | `everpure-ha-crash` | Secondary detects expired drive-quorum claims in about 1 s. |
| `flasharray.primaryCrashPauseS` | 16 | verified | `everpure-ha-crash` | No array IO for a few seconds up to ~16 s; the model uses the documented upper bound. |
| `flasharray.promotionMaxS` | 15 | verified | `everpure-ha-timing` |  |
| `flasharray.ioDelayTimeoutS` | 15 | verified | `everpure-ha-iodelay` | Primary IO stall → giveback after 15 s, then promotion. |
| `flasharray.failoverObjectiveS` | 30 | verified | `everpure-ha-timing` | Design objective for a complete failover. |
| `flasharray.plannedFailoverPauseS` | 15 | verified | `everpure-ha-planned`, `everpure-upgrade` |  |
| `flasharray.hostMultipathRetryS` | 10 | inferred | `everpure-ha-scenarios` | Documented for generic hosts; applied to the CVM SPDK initiator by inference. |
| `flasharray.worstCaseSingleIoS` | 60 | verified | `everpure-host-timeouts` |  |
| `flasharray.controllerRebootS` | 300 | assumption | `everpure-upgrade` | Model value for one controller reboot during NDU (minutes; longer with firmware updates). Replace from lab testing. |
| `flasharray.serviceTimeMs` | { read: 0.2, write: 0.15 } | assumption |  | Illustrative array service time for displayed latency only; never drives timing. Replace from lab measurements. |
| `guest.linuxScsiTimeoutS` | 60 | verified | `ntnx-ahv-admin-11.2` | Recommended Linux guest SCSI device timeout. |
<!-- coverage:end -->

## Assumptions and unverified values

These are the values the lab plan (`lab-validation-plan.md`) should upgrade first.

| Field | Value | Why this value | Lab |
|---|---|---|---|
| `redirector.redirectStallS` | 3 s | No AHV figure is published. A few ticks covers QEMU's re-login to the remote Stargate after the redirect decision (SPEC §6.3 "2–3 ticks"). | L3 |
| `bond.slbRebalanceIntervalS` | 10 s | The documented Open vSwitch default ("Every 10 seconds, vswitchd rebalances"). Whether AHV tunes `bond-rebalance-interval` is not public. | L13 |
| `externalStorage.multipathPolicy` | active-active | The policy Nutanix configures is not public. SPDK supports active-passive and active-active, and its multipath example uses active-active round-robin. | L12 |
| `externalStorage.ioQueuesPerPath` | 4 | Each NVMe/TCP queue is one TCP connection (NVMe/TCP spec). SPDK asks for up to 1024 IO queues, capped by the target and CPU count. 4 is a readable model abstraction. | L12 |
| `externalStorage.keepAliveTimeoutS` | 10 s | The SPDK `bdev_nvme` default `keep_alive_timeout_ms`. | L5 |
| `externalStorage.reconnectDelayS` | 20 s | `reconnect_delay_sec` in SPDK's multipath example (`-o 20`). | L5 |
| `externalStorage.controllerLossTimeoutS` | −1 (forever) | SPDK semantics: −1 means reconnect forever and never delete the controller, as in SPDK's multipath example (`-l -1`). This matches the deployment guide's default of retrying until the array responds. Exported as `RECONNECT_FOREVER`. | L1, L5 |
| `cluster.zkMembersFt1` / `zkMembersFt2` | 3 / 5 | Only a community copy of the Bible text says "three or five nodes, depending on the redundancy factor". It is consistent with Bible 4i (FT2 means metadata RF5 and at least 5 nodes). | — |
| `hci.rebuildGiBpsPerNode` | 0.5 GiB/s | No per-node figure is published. Public 2018 lab tests (Josh Odgers, parts 1 and 3) work out to about 0.3–0.6 GB/s per surviving node, and a KB (cited by title) gives "expected 1 to 2 hours" for an all-flash node rebuild. | — |
| `hci.diskSmartCheckS` | 120 s | Hades runs a `smartctl` short self-test (KB "Disk Manager (Hades)", by title), which takes a minute or two; no Nutanix duration is published. | — |

**Not generic-host guidance.** The Everpure "NVMe/TCP Best Practices" KB (`everpure-nvme-tcp-bp`) needs a support login, and its content could not be read for this pass. The NVMe assumptions are therefore taken from public SPDK documentation only, because SPDK is the initiator the integration uses (Bible 8c).

## Verification log (2026-10-27)

| Source | Status | Result |
|---|---|---|
| `ntnx-ncp-everpure-deploy-7.6` (local portal copy) | Read | Confirmed N−2 / N−3, retry-until-array-responds, the per-VM force-shutdown timeout, 10,000 vDisks, 3–32 nodes, and "Every AOS vDisk is a volume on Everpure FlashArray". Table 9 requires **Purity//FA 6.11.8** for NVMe/TCP. |
| `ntnx-ncp-everpure-compat-7.6` (local portal copy) | Read | **The PDF has no table.** Page 4 only links to the portal's External Storage Compatibility Matrix (`ntnx-storage-compat-matrix`), which renders with JavaScript and could not be read. |
| `ntnx-ahv-admin-11.2` (local portal copy) | Read | Confirmed the 40 s disconnect, the vswitch quick update thresholds (> 20 s services, > 30 s HA), LACP fast 3 s / slow 90 s, and the 60 s Linux SCSI timeout. |
| `everpure-nutanix-req` | Read | Purity//FA 6.10.3+ is the integration minimum (AOS 7.5+, AHV 11.0+). 10,000 vDisks needs AOS 7.6 with Purity//FA 6.11.8+ or 6.12.0+. 3–32 nodes. ActiveCluster: co-existence only. |
| `everpure-nutanix-rn` | Read | The AOS 7.6 features (1:1 vDisk→volume with no metadata volume, 10,000 vDisks, FA async/ActiveDR/SafeMode) require Purity//FA 6.11.8 or 6.12.0. No Purity//FA line newer than 6.12 is listed. |
| `everpure-nutanix-net-bp` | Read | Confirmed MAC pinning, at least 2 storage VLANs, and MTU 9216 on the fabric / 9000 at endpoints. |
| `ntnx-bible-5b`, `-4i`, `-4a`, `-8c` | Read | Confirmed the HA timeline (1 Hz, T20/T60/T120, 45 s), the 30 min ring detach, rebuild "immediately" (no repair-delay timer), 3 offline events per hour, 95 % read-only, the 75 % resilient-capacity warning, 300 s owner migration, and PR fencing. The Bible does not give the redirector NOP interval. |
| `ntnx-blog-cvm-failure` | Read (archived) | The live URL returns 404. The archived copy confirms the "two or more times in a 30-second period" rule and failback after "at least 30 seconds" stable. |
| `spdk-jsonrpc`, `spdk-nvme-multipath` | Read | Keep-alive default 10 s. The multipath example uses `-l -1 -o 20`, active_active / round_robin. |
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
| SPDK / OVS / NVMe | `spdk-nvme-multipath`, `spdk-jsonrpc`, `ovs-bonding`, `ovs-vswitchd-conf`, `nvme-tcp-spec` |

Third-party blogs and the patent in `nutanix-hci.md` (joshodgers.com, derekseaman.com, patents.google.com) are background only. They are not in the registry, and no profile value depends on them.
