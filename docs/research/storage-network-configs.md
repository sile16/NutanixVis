# T1 storage network configurations (NVMe/TCP to Everpure FlashArray)

All of these designs share some rules:
- Two storage VLANs, one per fabric.
- Every node and both FA controllers cabled to both switches.
- MTU 9000 end to end. Field practice treats it as required; the deployment guide says recommended.
  - The AHV 11.2 Admin Guide says, in general, that Nutanix does not support higher MTU values on CVM network interfaces. The NCP with Everpure FlashArray Deployment Guide 7.6 explicitly creates the FlashArray vswitch and the External Storage internal interface with MTU 9000 (left empty, it defaults to 1,500 bytes). **For the external-storage segment, the deployment guide governs.**
- STP on, with edge ports facing nodes and array.
- **PFC and global pause off.**
- A single L2 hop from node to array.

In every design, NVMe multipathing runs inside the CVM (Stargate's NVMe/TCP initiator) across one path per (CVM storage interface × FA target port on the same VLAN). The design only changes **what sits under** those paths. Each design is a simulator option (`storage-vswitch-layout`, `vs1-bond-mode`, `array-port-vlans`).

## The designs

### A. One storage vswitch, Active-Active with MAC pinning (`balance-slb`)

**Shape:** one vswitch holds both storage NICs (one to each switch). Both node switch ports are 802.1Q trunks carrying both storage VLANs, and so is the ISL. OVS places each CVM storage interface (one source MAC per VLAN) on one uplink; AHV offers no way to choose which (`docs/research/ovs-bond-behavior.md`).

**Pros**
- Matches the Everpure KB and the Cisco Validated Design.
- No switch-side LAG or MLAG needed.
- Both uplinks usually carry traffic, when the two storage interfaces land on different NICs.
- A single NIC or cable failure is absorbed by the bond and no NVMe path is lost: the moved interface reaches its VLAN's FA ports across the ISL.

**Cons**
- The bond isn't VLAN-aware: it pins, fails over and rebalances an interface without checking which VLANs a member reaches. Isolated VLANs (VLAN A only on switch A) under a bond are therefore a broken configuration, and the simulator does not offer them: every bonded layout trunks both storage VLANs on both switches and the ISL.
- Which member each interface lands on, and so how much storage IO crosses the ISL, is up to OVS. With access array ports (VLAN A only on switch A's array ports) it ranges from none (each interface on its own VLAN's switch) to all of it (both swapped). A NIC or switch failure and its restore can leave the placement swapped; OVS rebalancing moves a hash only off a member with at least 2 loaded hashes, by at least 3 % of load, and only if the move narrows the gap (OVS bonding docs; `docs/research/ovs-bond-behavior.md`). With trunked array ports (one IP per VLAN on every port, 8 data IPs) every interface has two portals on each switch, so active-active multipathing sends about half its IO over the ISL whatever the placement. The UI shows the share on the ISL edge.
- Rebalance interval: the OVS default is 10 s (`bond-rebalance-interval`). A Nutanix technical marketing post (2020, Nutanix Community) says Nutanix recommends 30 s, and AHV sets 30 s on its balance-slb bonds (`inferred`).
- **Multicast and broadcast** are accepted on only one member ("accepting multicast and broadcast packets on only the active member", OVS bonding docs). The AHV 11.2 Admin Guide lists MAC pinning as "Works with caveats for multicast traffic". A Nutanix Community answer adds that inbound multicast then arrives on one adapter only, so IGMP snooping on the switches can drop it: disable snooping or configure static IGMP groups. NVMe/TCP is unicast, so this matters for VM traffic on the same vswitch, not for storage paths.
- OVS documents active-backup as "the only bonding mode in which interfaces may be plugged into different upstream switches". The two-switch MAC-pinning design works because the switches relearn MACs: on carrier loss OVS moves the dead member's hashes at once (`bond_downdelay` default 0) and sends a RARP "gratuitous learning packet" for each moved MAC on the new member.
- Both storage VLANs have to be carried on both switches and the ISL, so the ISL is part of the storage path.
- Two failure layers (bond, then NVMe) make behavior harder to reason about.

**Simulator:** `storage-vswitch-layout: single-bond`, `vs1-bond-mode: balance-slb`.

### B. One storage vswitch, LACP (`balance-tcp`)

**Shape:** both NICs in one LAG, using LACP to an MLAG/vPC switch pair.

**Pros**
- The Nutanix deployment guide prefers it "when available".
- Each NVMe/TCP connection (admin plus IO queues) is hashed across both links, so a single path can use both NICs.
- Link loss is detected immediately.

**Cons**
- Needs MLAG/vPC across the two switches, which ties the A and B fabrics together into a shared failure domain.
- A failure that keeps carrier up (a hung switch, a unidirectional link) is only detected by the LACP timeout: ≤3 s fast, up to 90 s slow. Flows hashed to the dead member blackhole until then. OVS judges LACP liveness by LACPDU receipt alone (OVS `lib/lacp.c`), so a switch whose data plane hangs while its control plane keeps sending LACPDUs is never detected.
- Prism's Active-Active bond always sets the fast rate and LACP fallback to active-backup on every host, and neither can be changed afterwards, even with the CLI (AHV 11.2 Admin Guide). A slow host rate only exists if it was set outside Prism (`manage_ovs` or the AHV installer). A slow rate on the switch side only slows the switch's own detection; the host still detects in about 3 s because it asked for fast (`inferred`).
- With fallback-ab, a member whose LACP times out is detached while another member is still negotiated, so the LAG carries on with the survivor. Only when no member is negotiated does the bond run active-backup over all members.
- Switching to it requires a rolling host reboot.
- Field teams usually avoid LACP for storage, on the same reasoning as for iSCSI.

**Simulator:** `vs1-bond-mode: balance-tcp`, `lacp-rate`, `mlag`.

### C. One vswitch per fabric, "No Uplink Bond" (`per-fabric`)

**Shape:** two storage vswitches per node, each with one NIC to one switch and one storage interface (VLAN). There is no bond; NVMe multipathing alone handles failover.

**Pros**
- The simplest failure model, closest to classic iSCSI/NVMe host design: fail one port or switch and that fabric's paths are lost, while IO continues on the other fabric.
- Keeps the A and B fabrics truly independent, with no shared bond, LAG or MLAG.
- No risk of a stranded interface.
- Works naturally with isolated VLANs and storage VLANs kept off the ISL (0 % of storage IO on the ISL with access array ports).

**Cons**
- Everpure's KB discourages no-bond modes (exceptions are allowed; check with the Nutanix team).
- A NIC failure always costs that fabric's paths, which a bond could otherwise have saved. Detection is at KATO (5 s), and in-flight IO on lost paths waits CQT (30 s) before retry.
- More vswitches and IP pools to configure.

**Simulator:** `storage-vswitch-layout: per-fabric`.

## Cross-cutting choices

| Choice | Options | Trade-off |
|---|---|---|
| Storage VLAN placement (derived) | Bonded `vs1`: both storage VLANs on both switches and the ISL. Per-fabric with access array ports: VLAN A only on switch A, B only on B, off the ISL | A bond does not check VLANs, so it needs every storage VLAN on every member. Per-fabric keeps fabrics independent and single-hop. |
| Array data ports (`array-port-vlans`) | **Access** (one IP per port, 4 data IPs; default) vs **trunked** (one IP per storage VLAN on every port, 8 data IPs) | Access: the ISL share depends on where OVS placed each interface (0 % to 100 %). Trunked: every interface reaches portals on both switches, a switch failure costs only half of each interface's paths, and about half the storage IO crosses the ISL. |
| Switch-port mode | Node ports trunk, FA ports **access** (untagged) or trunk | It's simpler to tag on the switch side. An untagged CVM interface on an access port avoids most "network validation failed" setup errors. |
| MTU | 9000 everywhere (fabric 9216) vs 1500 | A mismatch anywhere fails large IO while small IO and keep-alives still work, which is hard to diagnose. Verify with `ping -M do -s 8972` (see `docs/commands.md`). |
| Flow control | Off (required) | PFC and global pause are not supported by the FlashArray for NVMe/TCP. |

## Same failure, three designs (access array ports)

| Failure | A: MAC pinning | B: LACP + MLAG | C: per-fabric no-bond |
|---|---|---|---|
| One node NIC or cable | The interface moves to the other NIC and reaches its portals over the ISL; no path is lost. | LAG survives on the other member; no path is lost. | That fabric's paths are lost after KATO. IO continues on the other fabric. |
| One switch | All of one VLAN's paths are lost after KATO. | LAG survives; paths to FA ports on the dead switch are lost. | All of one fabric's paths are lost after KATO. |
| Hung switch (carrier up) | Paths through it are lost after KATO. | Flows hashed to it blackhole until the LACP timeout (≤3 s fast / ≤90 s slow), then move. | Paths through it are lost after KATO. |
| Hung switch, seen by `vs0` | LACP `vs0` (simulator default): detached within ~3 s, management carries on. Active/Backup `vs0`: every host whose active member is on that switch is cut off; see below. | Same | Same |
| Worst case for a single IO | ≈ KATO + CQT (≈35 s), below the 60 s guest timeout | Slow LACP can exceed it | ≈ KATO + CQT (≈35 s) |

## The hung switch and `vs0`

`vs0` (management, CVM-to-CVM, live migration) is Active/Backup in the Deployment Guide 7.6 (Table 2), so a storage design choice does not protect the cluster from a hung switch. The simulator defaults `vs0` to **Active-Active LACP over MLAG** instead (owner decision): OVS judges LACP liveness by LACPDU receipt, so a switch that hangs and stops sending them is detached within about 3 s at the fast rate Prism sets, and the cluster keeps quorum (scenarios T1-20, T1-21). A switch whose data plane hangs while its control plane keeps sending LACPDUs is still never detected. The points below apply when `vs0` is Active/Backup (`vs0-bond-mode: active-backup`).
- **Active-backup only watches carrier.** OVS `bond-detect-mode` is carrier or miimon, both link-state checks; there is no ARP or beacon probing. AHV's gateway checks run only while a vswitch is being changed. A switch that stops forwarding with its links up is never detected, and the only recovery is to turn it into carrier loss: power the switch off or admin-down its ports. OVS then fails over at once.
- **The active member decides who is cut off.** OVS makes "the first member to be enabled" active, which is usually eth0 → Switch A on every host. If Switch A hangs, every CVM loses every other: Zookeeper quorum is lost and writes stop cluster-wide, even though each CVM's NVMe paths through Switch B are healthy, and AHV HA restarts nothing because no side has quorum (scenario T1-20).
- **Pinning spreads the risk.** `ovs-appctl bond/set-active-slave <bond> <interface>` (Everpure "Configure Nutanix Cluster for FlashArray") lets you put half the hosts on each switch. A hung switch then isolates only its hosts. If the rest keep quorum, the isolated hosts are fenced at T+60 and their VMs restart elsewhere (scenario T1-21, where 2 of 4 nodes meet the N−2 rule). On HCI the remaining side needs a Zookeeper majority, which an even split does not always give: with seats on nodes 1–3 of a 4-node cluster, the side holding nodes 2 and 4 has only one seat. Simulator option: `vs0-active-member: first | alternate`.
- No Nutanix field report of a hung switch with link up was found. The closest public analogue is Broadcom KB 426396 for ESXi, whose remedy is the same: admin-down the ports.

## Sources (network behavior)

All public. Citation ids are from `src/domain/citations.ts` where one exists.
- Open vSwitch, Bonding (`ovs-bonding`): https://docs.openvswitch.org/en/latest/topics/bonding/ ("The active member is simply the first member to be enabled", "Every 10 seconds, vswitchd rebalances", the 1 Mbps / 3 % rule, multicast on the active member only, RARP learning packets).
- Open vSwitch, ovs-vswitchd.conf.db(5) (`ovs-vswitchd-conf`): https://www.openvswitch.org/support/dist-docs/ovs-vswitchd.conf.db.5.txt (`bond-detect-mode`, `bond-rebalance-interval`, `bond_downdelay`, LACP fast and slow rates).
- Open vSwitch source, `lib/lacp.c` (`ovs-lacp-source`): https://github.com/openvswitch/ovs/blob/main/lib/lacp.c (receive timer = 3 × the LACPDU interval; fallback-ab detaches defaulted members while a negotiated lead exists).
- AHV Administration Guide 11.2 (`ntnx-ahv-admin-11.2`): https://portal.nutanix.com/page/documents/details?targetId=AHV-Admin-Guide-v11_2:AHV-Admin-Guide-v11_2 (Table 9 bond types, Active-Active fast rate and fallback, 3 s / 90 s detection, `bond/show` and `lacp/show`, `manage_ovs show_uplinks`, the CVM MTU statement).
- NCP with Everpure FlashArray Deployment Guide 7.6 (`ntnx-ncp-everpure-deploy-7.6`, Nutanix portal): Table 2 vswitch layout, MTU 9000 on the FlashArray vswitch and internal interface.
- Everpure, Configure Nutanix Cluster for FlashArray (`everpure-nutanix-cfg`): https://support.everpuredata.com/r/nutanix/configure-nutanix-cluster-for-flasharray (preferred active uplink, `ovs-appctl bond/set-active-slave`).
- Nutanix Community, VM network troubleshooting (`ntnx-community-slb-rebalance`): https://next.nutanix.com/questions/22699 (rebalance interval "10 second by default, Nutanix recommends 30 seconds").
- Nutanix Community, LACP bond mode balance-slb: https://next.nutanix.com/ahv-virtualization-27/lacp-bond-mode-balance-slb-43509 (inbound multicast on one adapter; IGMP snooping).
- Broadcom KB 426396 (ESXi analogue, not Nutanix): https://knowledge.broadcom.com/external/article/426396/network-loss-on-esxi-during-physical-swi.html
