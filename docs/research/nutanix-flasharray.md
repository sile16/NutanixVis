# Nutanix + Everpure FlashArray (external storage): research notes (2026-10-27)

**Scope.**

- **Public sources only.** The repo is public. Facts known only from internal Everpure material are excluded here; they live in git-ignored `docs/internal/`, and must not be copied into tracked files.
- **Current release only.** This covers the current release behavior; historical behavior is out of scope.
- **Platform.** AHV only.

**Naming.** Current documentation uses **Everpure** (formerly Pure Storage). Both Nutanix and Everpure docs use that name.

## Source key

| Key | Document |
|---|---|
| DEPLOY-GUIDE | Nutanix: *Nutanix Cloud Platform with Everpure FlashArray Deployment Guide*, NCP with Everpure FlashArray 7.6 (portal.nutanix.com). A local copy is in `NutanixDocs/` (git-ignored). |
| COMPAT | Nutanix: *NCP with Everpure FlashArray Compatibility and Interoperability Matrix 7.6* (Sept 22, 2026). The matrix table is an image in the PDF and needs a manual read. |
| REQ | [Requirements, Limits and Feature Compatibility](https://support.everpuredata.com/r/nutanix/nutanix-and-everpure-requirements-limits-and-compatibility) |
| RN | [Release Notes: Nutanix and Everpure Integration](https://support.everpuredata.com/r/nutanix/release-notes-nutanix-and-everpure-integration) |
| NET | [Network Configuration for NCP with FlashArray](https://support.everpuredata.com/r/nutanix/nutanix-everpure-bp-network-config) |
| CFG | [Configure Nutanix Cluster for FlashArray](https://support.everpuredata.com/r/nutanix/configure-nutanix-cluster-for-flasharray) |
| BIBLE-HLD | [Nutanix Bible: External Storage High-Level Design](https://www.nutanixbible.com/8b-book-of-external-storage-high-level-design.html) |
| BIBLE-ARCH | [Nutanix Bible: External Storage Architecture](https://www.nutanixbible.com/8c-book-of-external-storage-architecture.html) |
| BIBLE-AHV | [Nutanix Bible: AHV How It Works](https://www.nutanixbible.com/5b-book-of-ahv-how-it-works.html) |
| HA-Explained | [HA Failover Explained](https://support.everpuredata.com/r/purityfa-general-administration/ha-failover-explained) |
| HA-Timing | [HA Timing Objectives](https://support.everpuredata.com/r/purityfa-general-administration/ha-timing-objectives) |
| HA-Crash | [Primary Crash or Quorum Loss](https://support.everpuredata.com/r/purityfa-general-administration/primary-crash-or-quorum-loss) |
| HA-Planned | [Planned Failover](https://support.everpuredata.com/r/purityfa-general-administration/planned-failover) |
| HA-Secondary | [Secondary Crash](https://support.everpuredata.com/r/purityfa-general-administration/secondary-crash) |
| HA-IODelay | [IO Delay/Timeout](https://support.everpuredata.com/r/purityfa-general-administration/io-delaytimeout) |
| HA-Scenarios | [HA Failover Scenarios and Behavior](https://support.everpuredata.com/r/purityfa-general-administration/ha-failover-scenarios-and-behavior) |
| HOST-TMO | [Setting Host Disk Timeouts](https://support.everpuredata.com/r/flasharray-connectivity/setting-host-disk-timeouts) |
| ANA-FAQ | [FAQ: NVMe-oF and VMware](https://support.everpuredata.com/r/howtos-for-vmware-solutions/faq-nvmeof-and-vmware) (the ANA-state statement applies to physical FA generally) |
| TCP-BP | [NVMe/TCP Best Practices](https://support.everpuredata.com/r/flasharray-connectivity/nvme-tcp-best-practices) |
| NPIV | [What does NPIV look like in action](https://support.everpuredata.com/r/flasharray-block-services/what-does-npiv-look-like-in-action) |
| UPG | [Performing the Upgrade](https://support.everpuredata.com/r/purityfa-upgrades/performing-the-upgrade-05) |
| FA-REP | [Using FA Replication with Nutanix](https://support.everpuredata.com/r/nutanix/fa-rep-nutanix-using-fa-replication) |

## 1. The integration (current release)

- **Shape.**
  - The FlashArray is external block storage for a Nutanix Cloud Infrastructure compute cluster (NCI-C).
  - It is **AHV only and NVMe/TCP only** (REQ). RDMA/iSER is not supported for the storage segment (DEPLOY-GUIDE).
- **Versions.**
  - The current Nutanix release is AOS 7.6 with AHV 11.
  - Supported Purity//FA versions come from COMPAT and REQ. The research found 6.11.8+ and 6.12.x (RN); confirm this against COMPAT when building the version matrix.
- **Supported arrays** (DEPLOY-GUIDE):
  - //X20, //X50, //X70, //X90
  - //XL130, //XL170, //XL190
  - //C40, //C50, //C60, //C70, //C90
  - R3, R4 and R5 models
- **Limits** (DEPLOY-GUIDE):
  - **At least 3 nodes.** 1- and 2-node clusters are not supported.
  - **One FlashArray per cluster.** One FA can serve many clusters.
  - **At most 10,000 vDisks per cluster.**
  - **Capacity:** at least 1 TB per node in the container for Nutanix internal use.
  - **CVM sizing:** 12 vCPU and 32 GB by default.
  - **Not supported:** Protection Domain DR from Prism Element, NDB and NUS.
  - **Required setup order:** external storage must be configured before containers or VMs are created.
- **Architecture** (DEPLOY-GUIDE; BIBLE-HLD; BIBLE-ARCH):
  - **Volume mapping.** Every AHV VM disk is an AOS vDisk, and each vDisk is backed by **one thin FA volume** that is provisioned ad hoc and presented dynamically. There is no separate change-tracking volume.
  - **CVM and Stargate.** A CVM still runs on every node. Its Stargate uses an SPDK user-space NVMe/TCP initiator.
  - **Cluster service data.** Cassandra, Curator and Zookeeper data lives on dedicated volumes on the array.
  - **vDisk fencing.** Only the Stargate holding a vDisk's lock does IO to it, fenced by an NVMe Persistent Reservation.
  - **Reserved FA objects.** Volumes and hosts on the FA whose names start with `nx-` are managed by Nutanix. Do not modify them.
  - **FA prerequisites.** A realm and pod must exist before the FA is attached, along with a realm admin user.
- **Pod quota** (DEPLOY-GUIDE):
  - No quota is set by default.
  - If a quota is reached: FA alerts, degraded or timed-out FA API responses, and IO and DR snapshot operations may fail.
  - Nutanix recommends advertised capacity on containers instead of quotas.
- **DR** (DEPLOY-GUIDE; FA-REP):
  - Prism Central-based Nutanix DR is supported: async, SyncRep, and Metro.
  - ActiveCluster is not supported on Nutanix volumes (REQ).

## 2. Connectivity and multipathing

- **Virtual switches** (DEPLOY-GUIDE Table 2): two virtual switches, each with at least 2 physical NICs.
  - `vs0` carries management, live migration, DR replication and application traffic. Its bond is Active/Backup or Active/Active, and its MTU is 1500.
  - `vs1` carries **storage data only**. Its bond is **Active/Active with LACP when available, otherwise Active/Active with MAC pinning**. Nutanix recommends LACP on the switch ports that carry storage traffic.
- **Everpure bonding guidance** (NET):
  - "You should configure the Ethernet interfaces on the Nutanix nodes in Active/Active with MAC pinning for NVMe/TCP traffic."
  - "Nutanix and Everpure do not recommend configuring Ethernet interfaces using No-Bond modes, but as with many recommendations there can be exceptions." Customers with such a need should confirm with their Nutanix team.
- **Storage VLANs and switches** (NET):
  - Use "at least two VLANs dedicated to NVMe/TCP data storage traffic". More are allowed, with limited benefit.
  - "configure VLAN tagging between the nodes and the switches and between the switches and the arrays."
  - Dedicated switches per VLAN, trunked switches, and vPC/MLAG are all acceptable designs.
- **Jumbo frames.** MTU 9000 is optional but recommended end to end. The supported range is 1280–9000 (DEPLOY-GUIDE). Use MTU 9216 on the fabric (NET).
- **FA storage ports.** 2 or 4 interfaces per controller, at 25 or 100 GbE. The sample configuration gives each FA NIC port its own subnet and VLAN, 4 VLANs in total (DEPLOY-GUIDE Table 11).
- **Everpure guidance** (NET, CFG):
  - Two switches, with every node and every controller connected to both.
  - Storage networks configured as Nutanix Service Networks with External Storage enabled.
  - No LAG across FA controllers. NVMe/TCP on port 4420.
- **FA management.** Each controller has a management interface plus a controller virtual IP that moves to whichever controller is primary (DEPLOY-GUIDE Tables 3 and 10).
- **ANA.** A physical FA reports **every path as ANA Optimized**, including paths on the secondary controller (ANA-FAQ).
- **Initiator timers.** The keep-alive, reconnect and controller-loss values used by the integration are **not publicly documented** (gap), so they are labeled `assumption` in the model. TCP-BP gives generic host guidance that does not apply to this integration.
- **Path selection policy.** Not publicly documented (gap). The model assumes round-robin across live Optimized paths.

## 2a. Bond vs individual NICs: why this differs from generic Linux NVMe/TCP guidance

**The generic pattern.** Everpure's generic host guidance for Linux NVMe/TCP and iSCSI is to use **unbonded NICs on separate subnets, with multipathing in the host OS** (native NVMe multipath or dm-multipath). That pattern assumes the OS that owns the initiator also owns the physical NICs.

**Why it doesn't apply here.** In this integration that is not true:

1. **The initiator is inside a VM.** It is SPDK, running in the CVM as part of Stargate (BIBLE-ARCH). The AHV host OS does no NVMe/TCP, and there is no multipathd.
2. **The CVM reaches the network through an AHV virtual switch.** Its storage interfaces are vNICs on `vs1`, and `vs1` reaches the wire through an OVS bond of at least 2 physical NICs (DEPLOY-GUIDE Table 2). The physical NICs can't be handed to the initiator directly.
3. **Multipathing still happens above the bond, but in Nutanix's software.** BIBLE-ARCH says multipathing and queue depth are "entirely done in software by Nutanix and the storage vendor" and that "No manual protocol network configuration is required." Paths come from the CVM's storage interfaces on at least 2 VLANs times the FA target ports.

**The result: two failure-handling layers.**

- **Bond (below):** handles a node NIC or cable failure by moving the vNIC's MAC to the surviving uplink.
- **NVMe multipath (above):** handles the loss of an FA port, an FA controller, a switch-to-FA link, or a path the bond couldn't save.

The bond only saves a path if the VLAN is present on the surviving uplink's switch. That is the practical reason for NET's VLAN-tagging recommendation. The two-layer interaction is `inferred` from the documented components; neither vendor publishes it as a failure walkthrough.

**Not publicly documented:**

- How many storage interfaces or IPs each CVM gets per VLAN.
- The SPDK path selection policy.
- The order in which the bond and the initiator react to a switch failure.

## 2b. Bond types and path spreading

From the AHV 11.2 Administration Guide, Table 9 "Bond Types":

- **Active-Backup.** Recommended for `vs0`. "transmits all traffic over a single active adapter."
- **Active-Active with MAC pinning (balance-slb).** "Places each VM NIC on a single adapter at a time. Do not use this bond type with link aggregation protocols such as LACP." Maximum host throughput is 2 links, and per-vNIC throughput is 1 link.
- **Active-Active (balance-tcp).** "LACP and link aggregation required. … balancing VM NIC TCP and UDP sessions among adapters." Defaults to "Speed—Fast (1s)" and "Mode—Active fallback-active-backup".
- **No Uplink Bond.** 0 or 1 uplinks. Every other bond type needs at least 2 uplinks per node.
- **Uniformity.** Do not mix bond modes across hosts in a cluster.

From the deployment guide ("Creating an Internal Interface"): each storage segment uses one VLAN on `vs1`, and **each host takes one IP from the segment's pool**. So the number of storage vNICs per CVM equals the number of storage segments. Everpure recommends at least 2 (NET).

**Not documented publicly:**

- The Stargate/SPDK multipath policy. SPDK's NVMe bdev supports both active-passive and active-active (round-robin or queue-depth selection).
- The number of IO queues (TCP connections) per NVMe controller.
- Whether Nutanix tunes the OVS `balance-slb` rebalance interval. The OVS default is 10 s.

These are `assumption` values in the model and are tested by lab experiments L12 and L13.

## 3. FlashArray controller HA

**Architecture.**
- The back end is active/passive. Only the **primary** owns the drives, through a heartbeat claim on a drive quorum.
- Front-end ports on **both** controllers serve IO. The secondary forwards IO to the primary (HA-Explained).

**Failure behavior.**

| Event | Behavior | Source |
|---|---|---|
| Primary crash or quorum loss | The secondary detects the expired claims in about 1 s and promotes. The array serves no IO for a few seconds, up to about 16 s. | HA-Crash |
| IO stall on the primary | After the IO delay timeout of 15 s, a giveback. The maximum pause is the IO delay plus promotion. | HA-IODelay |
| Design objectives | Full failover ≤30 s. Trigger ≤15 s. Promotion ≤15 s. | HA-Timing |
| Worst case for a single IO | 60 s | HOST-TMO |
| Planned failover or NDU | Pause ≤15 s. The upgrade reboots the secondary first, then the primary. | HA-Planned, UPG |
| Rebooting controller | Its Ethernet/NVMe ports disappear, because NPIV covers FC SCSI only. | NPIV |
| Secondary crash | No array-wide pause. Only IO on the secondary's paths stalls, then retries on the primary's paths. | HA-Secondary |
| Host-side port or link loss | Multipath retries within about 10 s if another path exists. | HA-Scenarios |

## 4. Nutanix compute cluster HA (DEPLOY-GUIDE "Compute Cluster High Availability")

- **Availability domain.** VM data is in the array's own availability domain, so surviving compute capacity bounds VM availability, not an in-cluster FT level.
- **Simultaneous node-failure tolerance:**
  - Clusters with fewer than 5 nodes tolerate **N−2** failures. A 3-node cluster tolerates 1 and a 4-node cluster tolerates 2.
  - Clusters with 5 or more nodes tolerate **N−3**. A 5-node cluster tolerates 2, a 6-node cluster 3, and a 10-node cluster 7.
- **Cluster service recovery.** After a multi-node failure, services resume on the survivors automatically, with no manual intervention.
- **Per-VM storage path-loss handling.**
  - By default, a node **retries IO until the array responds**.
  - An optional **per-VM force-shutdown timeout** restarts the VM on a node with array connectivity.
- **Host failure (AHV HA)** (BIBLE-AHV):
  - The Acropolis leader polls each host at 1 Hz.
  - T+20: the 40 s timeout starts. T+60: IO from the failed host is fenced. T+120: VMs restart.
  - VMs on an isolated host self-terminate 45 s after their first failed IO.
- **IO path** (BIBLE-AHV): VM → AHV iSCSI redirector → local Stargate. Whether the redirector moves IO to a remote Stargate when the local CVM has lost only its array paths is **not documented** (gap).

## Timers and thresholds

| Name | Value | Source | Confidence |
|---|---|---|---|
| NVMe keep-alive / reconnect / controller-loss (integration) | — | not public | assumption |
| FA IO delay timeout | 15 s | HA-IODelay | verified |
| FA promotion | ≤15 s | HA-Timing | verified |
| FA total failover objective | ≤30 s | HA-Timing | verified |
| FA primary crash: detection / pause | ~1 s / a few s to ~16 s | HA-Crash | verified |
| FA planned failover pause | ≤15 s | HA-Planned | verified |
| FA worst-case single IO | 60 s | HOST-TMO | verified |
| Multipath retry after path loss | ~10 s | HA-Scenarios | verified (generic host) |
| AHV HA timeline | 1 s poll; T20 / T60 / T120 | BIBLE-AHV | verified |
| Isolated VM self-terminate | 45 s | BIBLE-AHV | verified |
| Node-failure tolerance | N−2 (<5 nodes) / N−3 (≥5) | DEPLOY-GUIDE | verified |
| Path-loss default | retry until array responds | DEPLOY-GUIDE | verified |
| Max vDisks per cluster | 10,000 | DEPLOY-GUIDE | verified |
| Minimum cluster size | 3 nodes | DEPLOY-GUIDE | verified |

## Gaps (need a public source or an owner decision)

- The integration's NVMe keep-alive, reconnect and controller-loss values, and its path policy.
- Whether the redirector moves IO to a remote CVM when only the local CVM's array paths are lost.
- The guest-visible effect of a long array outage.
- The default length of the per-VM force-shutdown timeout, if one exists.
- The COMPAT matrix table, which is an image in the PDF, so the supported Purity//FA list must be read manually.
