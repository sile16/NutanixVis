# Nutanix HCI failure behavior: research notes (2026-10-27)

Scope: AHV only (ESXi is out of scope), current release behavior only. Historical notes (for example AOS 4.7 DND) are background and must not be shown in the app.

**Confidence labels.** Unlabeled claims come from the Nutanix Bible or official Nutanix docs. **UNVERIFIED** means the claim comes from a community post or old blog, or could not be confirmed. The portal.nutanix.com docs and KBs render with JavaScript and could not be fetched directly, so official guides are cited by title:

- AHV 10.3 Administration Guide
- AOS 7.3 Command Reference

## 1. Components and leadership

| Component | Role | Leader? | Failover |
|---|---|---|---|
| Zookeeper / Zeus | Cluster config (Zeus is the client library) | Yes | Runs on 3 or 5 nodes depending on redundancy factor. A new leader is elected if the leader stops responding [1]. If a block fails, the ZK role migrates to another node and returns later [2]. Migration timing is UNVERIFIED. |
| Cassandra / Medusa | Metadata ring (consistent hashing) | Per-key owner | Writes need a Paxos majority [3]. Metadata RF3 under FT1, RF5 under FT2 [2]. |
| Stargate | Data IO, runs on every CVM | No | The hypervisor path redirects to another CVM (§3) |
| Curator | Background MapReduce: rebuild, ILM | Yes | Full scan about every 6 h, partial scan about every 1 h [1] |
| Prism | UI/API | Yes | Other nodes forward to the leader. VIP move timing is UNVERIFIED. |
| Acropolis (AHV) | Scheduler, HA, network controller | Yes, plus a worker per CVM [4] | New leader about T+20 s after the leader's host fails [5] |
| Cerebro | Replication/DR | Yes (from memory) | UNVERIFIED |

Data locality [4]:
- An extent group migrates after 3 random touches or 10 sequential touches within a 10-minute window.
- vDisk ownership migrates after 300 s or more of remote IO.

## 2. Data protection

- **Data and metadata RF:**
  - FT1 means data RF2 with metadata RF3.
  - FT2 means data RF3 with metadata RF5.
- **Minimum units** [2] (the same for nodes, blocks and racks):
  - FT1: 3 units, or 4 with erasure coding.
  - FT2: 5 units, or 6 with erasure coding.
- **FT2 node count:** RF3 needs 5 nodes, and two concurrent node failures are tolerated [2].
- **Mixed RF:** an FT2 cluster can host both RF2 and RF3 containers.
- **Block awareness:**
  - It needs at least 3 blocks.
  - Let X be the node count of the largest block. The remaining blocks must hold at least 2X nodes under FT1, or 4X under FT2.
  - No two Cassandra peers may share a block.
  - It is best-effort unless strict mode is opted into [2].
- **Write path** [2][3]:
  - A write lands in the local Oplog on SSD.
  - It is replicated synchronously to RF−1 other CVMs' Oplogs before the ack.
  - It drains to the extent store asynchronously.
  - Sequential writes with more than 1.5 MB outstanding bypass the Oplog.
- **Data locality:** writes are always local first. If the local CVM is down, all replicas go remote and RF is still met [4][7].

## 3. CVM failure

The failure matrix says: no HA event, no failed IO, and latency may rise [2].

**AHV**
- QEMU talks to an iSCSI redirector at `127.0.0.1:3261`, which health-checks the local Stargate with iSCSI NOPs, roughly every 1 s judging by log timestamps.
- When NOPs fail, the redirector marks the local Stargate unhealthy, and QEMU's retried login is redirected to a healthy remote Stargate.
- **Failback:** once the local Stargate recovers, the remote one quiesces and kills its sessions, and QEMU logs in locally again [5].
- How long IO pauses during redirect is **UNVERIFIED**. No published number exists; the model assumes a few seconds.


**Shared rules** [9]
- **Trigger:** a process failing to respond 2 or more times in 30 s triggers a redirect.
- **Failback:** happens after the original CVM has been stable for at least 30 s.

**Rebuild** starts as soon as Stargate is down, with no delay timer [6].

## 4. Host / node failure

### AHV HA [5]
- The Acropolis leader polls libvirtd on every host at 1 Hz.
- Timeline for a remote host failure:
  - T0: lost.
  - T20: the 40 s timeout starts.
  - T60: Stargates are told to block IO from that host (the fence).
  - T120: VMs are restarted.
- The AHV Admin Guide states it as: if the host stays disconnected for 40 s, its VMs restart, subject to resources.
- A cluster never runs more than one copy of a VM.
- **Reservation:**
  - Default is best-effort.
  - Guarantee mode reserves 1 host (FT1) or 2 hosts (FT2). Reservation is segment-based since 5.0.
  - Maintenance mode uses the reservation.
  - vGPU VMs are restarted on a best-effort basis.


### Rebuild
- Rebuild starts immediately on an unplanned failure [2].
- The work is spread across all nodes, so each node does about 1/N of it.
- A lab test rebuilt more than 5 TB in under 20 minutes at about 9 GBps [10].

### Cassandra
- If a node stays down for about 30 minutes, its CVM is detached from the metadata ring [2].
- This is the auto ring-repair feature (KB-1256), and it raises alert A1055 [11].
- The node is re-added after it has been stable for an unspecified time.

### Resiliency status
- The Prism Resiliency widget shows the status, as does `ncli cluster get-domain-fault-tolerance-status type=node|rackable_unit`.
- A Curator partial scan updates it.
- The per-component rows (Metadata, Zookeeper, Extent Groups, Oplog, Stargate health, Free Space) are UNVERIFIED.

## 5. Disk failure and degraded node detection (DND)

### Disk
- Stargate marks a disk offline after IO errors or when it stops responding past a threshold. The threshold value is UNVERIFIED.
- Hades then runs a SMART check and returns the disk to service if it passes.
- If a disk goes offline 3 times in 1 h, it stays offline.
- No HA event follows, and the rebuild starts immediately [2].
- Checksums are verified on every read, and an idle scrubber also checks the data.

### DND
- **What it is:** a CVM that is "partially unresponsive", for example because of a degraded NIC speed, packet drops, soft lockups, a partially bad disk or SATADOM, or ECC errors [12].
- **Alert:** A130087. DND is on by default.
- **Response:** the old AOS 4.7 behavior was to mark the node degraded, put it in maintenance mode and raise an alert [13]. What current AOS does is UNVERIFIED.

## 6. Network

### Bonds (OVS)
- The default bridge is `br0` with bond `br0-up` [14], in **active-backup** mode by default (AHV Admin Guide).
- **balance-slb** pins each VM vNIC to one uplink.
- **balance-tcp** requires LACP and spreads TCP sessions across uplinks.
- LACP **fast** detects a failure in ≤3 s and **slow** in up to 90 s. Match the setting on the switch and the host.
- `lacp_fallback` is recommended; its exact semantics are UNVERIFIED.
- `virbr0` is the internal bridge between the CVM and the host (192.168.5.x). It has no uplink, so physical failures never affect it.

### Single uplink or ToR failure with active-backup
- The bond fails over and no cluster event follows. This is inferred from the bond behavior rather than documented.

### Network segmentation
- The backplane runs on CVM eth2 on its own VLAN.
- Stargate does not monitor the health of a segmented network, so redundant uplinks are required [15].

### Partition [5]
- The side with quorum stays up, and VMs restart there. Quorum means a ZK majority (2/3 or 3/5) plus a Cassandra Paxos majority for each key.
- **Isolated AHV host:**
  - The fence happens at about T60.
  - Its VMs terminate 45 s after their first failed IO.
  - The VMs are restarted on the majority side by T120.

## 7. Multiple failures

- FT1 tolerates 1 concurrent failure and FT2 tolerates 2. Failures that are not concurrent are fine once the rebuild completes.
- **Beyond FT:**
  - Extents whose only replicas were lost become unavailable.
  - Metadata ranges lose Paxos quorum.
  - Losing 2 of 3 ZK members loses ZK quorum.
  - The result "may bring down the storage interface and limit access for all consumers" [16]. There is no official outcome table, so this is **UNVERIFIED**.
- **Read-only modes:**
  - Capacity at or above 95% [2].
  - On a 2-node cluster, a node failure plus an SSD failure on the survivor [17].
  - On a 1-node cluster, an SSD failure.
- **2-node clusters:**
  - Data is RF2 and metadata is RF4 across both nodes' SSDs [17].
  - The heartbeat runs every 2 s, and failover happens after 10 s (5 misses). Both values are UNVERIFIED.
  - On a heartbeat loss, both nodes pause IO and request a leadership lock from the Witness. The winner continues as a stand-alone cluster (patent US11194680).
  - Return to two-node mode requires 15 min of successful pings, then a Cassandra resync [18].
  - Behavior with no Witness is UNVERIFIED.

## 8. Recovery ordering

| When | What |
|---|---|
| T+0 | Failure |
| Seconds | Autopath redirect |
| Immediately when Stargate is down | Rebuild starts |
| T+20 / 60 / 120 s | AHV HA timeout starts / fence / VM restart |
| About 20 min for 5 TB | Rebuild complete (scales with N and data size) |
| 30 min | Cassandra ring detach |

On return:
- The local path is restored after 30 s stable.
- Over-replicated copies are cleaned up by a later Curator scan.
- Ring re-add happens through auto ring-repair.

## 9. Metro (out of scope for v1)

- Synchronous replication between clusters, with Witness, Automatic Resume or Manual modes.
- The default 30 s timeout before the Witness claim is UNVERIFIED.
- Replication resume is manual.
- A Witness failure alone does not affect VMs [19].

## 10. AHV 11.2 Administration Guide additions (official; local copy in `NutanixDocs/`)

- **Storage overview.** Each AHV host runs an iSCSI redirector. QEMU uses the redirector as its iSCSI portal, and on login the redirector redirects it to a healthy Stargate, preferring the local one.
- **CVM power-off.** VMs keep running, and their IO is redirected to another CVM ("Changing the CVM Name").
- **HA fault detection.**
  - Watches the heartbeat of the host's management services. If any of them is down, the host is marked disconnected.
  - Also marks the host disconnected if its root filesystem is corrupt or read-only.
  - A host that stays disconnected for **40 s** has its VMs restarted, subject to resources.
- **HA status.**
  - **OK:** the cluster is protected.
  - **Healing:** VMs are being restarted, and later locality is being restored.
  - **Critical:** the cluster can't tolerate another host failure. Start and migrate operations are restricted.
- **vSwitch Quick update.** An update over 20 s can restart some AOS services. **An update over 30 s triggers HA.**
- **LACP failure detection.** Fast mode detects within 3 s, slow mode within 90 s.
- **Linux guest SCSI timeout.** 60 s is recommended (load-balanced VGs section).

## 11. Compute-only (CO) and storage-only (SO) nodes

**From the AHV 11.2 Administration Guide (official):**

- **CO nodes:**
  - "There is no Controller VM (CVM) running on the CO node (VMs use CVMs running on the HCI nodes to access disks)."
  - Supported deployments are CO + HCI and CO + SO (the "Optimized Database Solution").
  - Clusters with CO nodes do not support creating VLAN Subnets.
- **SO nodes:**
  - "AOS never schedules any VMs on the SO node."
  - The cluster needs at least 3 functioning nodes at all times, and 3 schedulable nodes before the first SO node is added.
  - The SO node's CVM is sized at all cores minus 2, and RAM minus 16 GiB capped at 256 GiB.
- **Virtual switches:** SO nodes are compatible with virtual switches and don't need to be included manually.
- **Every AHV host runs the iSCSI redirector,** which redirects logins to a healthy Stargate, preferring the local one. On a CO node there is no local Stargate, so all storage IO crosses the network (inferred).

**From community sources (`unverified`, AOS 5.11 era):**

- Storage for CO VMs is sourced from the HC nodes "using a heuristics-based approach". IO is served over the network, with no local storage.
  - https://next.nutanix.com/community-blog-154/supercharging-your-nutanix-ahv-clusters-with-compute-only-nodes-33303
  - https://next.nutanix.com/how-it-works-22/what-are-the-nutanix-compute-nodes-37488
- A 2 HC : 1 CO ratio is recommended, starting with 4 HCI nodes, at 10 Gbps or more. At least 2 CO nodes are recommended so DB VMs can be restarted by HA.

**Gaps:**

- How the Stargate is selected and balanced for CO VMs.
- What the current version of "Deployment Specifications and Considerations for Compute-Only and Storage-Only Nodes" (Prism Element Web Console Guide) says. It is not in `NutanixDocs/`; add it.

## Timers and thresholds

| Name | Value | Source | Confidence |
|---|---|---|---|
| Autopath trigger | ≥2 misses in 30 s | [9] | inferred (blog now 404) |
| Autopath failback hold | 30 s stable | [9] | inferred |
| AHV redirector NOP interval | ~1 s | [5] | inferred from logs |
| AHV HA libvirt heartbeat | 1 s | [5] | verified |
| AHV host-down timeout | 40 s (starts ~T20) | [5], AHV Admin Guide | verified |
| AHV IO fence | T60 | [5] | verified |
| AHV VM restart | ≤T120 | [5] | verified |
| Isolated-host VM self-terminate | 45 s after first failed IO | [5] | verified |
| Acropolis leader re-election | ~T20 | [5] | verified |
| Rebuild start | immediate | [2][6] | verified |
| Cassandra ring detach | 30 min | [2], KB-1256 | verified |
| Curator partial / full scan | ~1 h / ~6 h | [1] | verified |
| Disk permanently offline | 3 offline events per hour | [2] | verified |
| Stargate read-only | 95% capacity | [2] | verified |
| vDisk owner migration | 300 s of remote IO | [4] | verified |
| Oplog bypass (sequential) | >1.5 MB outstanding | [3] | verified |
| LACP detection | fast ≤3 s / slow ≤90 s | AHV Admin Guide | verified |
| 2-node heartbeat / failover | 2 s / 10 s | community | unverified |
| 2-node return gate | 15 min | [18] | inferred |
| Metro failover timeout | 30 s | community | unverified |
| ZK leader election, Prism VIP move | — | — | unknown |

## Gaps to close

These need portal or KB access, or Nutanix engineering:

- How long AHV IO pauses during a CVM redirect.
- What current degraded node detection actually does.
- The outcome when failures exceed FT.
- 2-node behavior without a Witness.
- ZK migration and VIP move timings.
- balance-slb rebalance timing and `lacp_fallback` semantics.

## Sources

1. https://next.nutanix.com/how-it-works-22/controller-vm-components-38055
2. https://www.nutanixbible.com/4i-book-of-aos-data-resilience-and-ha.html
3. https://www.nutanixbible.com/4g-book-of-aos-data-io-path.html
4. https://www.nutanixbible.com/4a-book-of-aos-architecture.html
5. https://www.nutanixbible.com/5b-book-of-ahv-how-it-works.html
6. https://next.nutanix.com/how-it-works-22/data-rebuild-when-cvm-is-down-and-oplog-question-37706
7. https://joshodgers.com/tag/cvm/
8. (removed: ESXi-only source, out of scope)
9. https://nutanix.com/blog/nutanix-controller-failure-will-users-notice (now 404; text known from search snippets)
10. https://www.joshodgers.com/2018/05/30/nutanix-resiliency-part-1-node-failure-rebuild-performance/
11. https://next.nutanix.com/how-it-works-22/understanding-alert-node-marked-to-be-detached-state-37501
12. https://next.nutanix.com/ahv-virtualization-27/degraded-node-detection-42859
13. https://www.derekseaman.com/2016/06/nutanix-aos-4-7-immediately-available.html
14. https://www.nutanixbible.com/5a-book-of-ahv-architecture.html
15. https://next.nutanix.com/conversations/42742
16. https://next.nutanix.com/how-it-works-22/data-resiliency-status-critical-what-happens-when-another-node-goes-down-32101
17. https://next.nutanix.com/how-it-works-22/two-node-clusters-39244
18. https://next.nutanix.com/how-it-works-22/monitoring-a-two-node-cluster-during-failover-and-upgrade-38932
19. https://www.joshodgers.com/tag/witness/
- https://patents.google.com/patent/US11194680
