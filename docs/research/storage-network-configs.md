# T1 storage network configurations (NVMe/TCP to Everpure FlashArray)

All of these designs share some rules:
- Two storage VLANs, one per fabric.
- Every node and both FA controllers cabled to both switches.
- MTU 9000 end to end. Field practice treats it as required; the deployment guide says recommended.
- STP on, with edge ports facing nodes and array.
- **PFC and global pause off.**
- A single L2 hop from node to array.

In every design, NVMe multipathing runs inside the CVM (Stargate's NVMe/TCP initiator) across one path per (CVM storage interface × FA target port on the same VLAN). The design only changes **what sits under** those paths. Each design is a simulator option (`storage-vswitch-layout`, `vs1-bond-mode`, `vlan-placement`, `isl-storage-vlans`).

## The designs

### A. One storage vswitch, Active-Active with MAC pinning (`balance-slb`)

**Shape:** one vswitch holds both storage NICs (one to each switch). Each CVM storage interface (one per VLAN) is pinned to one uplink.

**Pros**
- Matches the Everpure KB and the Cisco Validated Design.
- No switch-side LAG or MLAG needed.
- Both uplinks carry traffic, since each storage interface is pinned to a different NIC.
- With VLANs on both switches, a single NIC or cable failure is absorbed by the bond, and no NVMe path is lost.

**Cons**
- The bond isn't VLAN-aware. With **isolated** VLANs (VLAN A only on switch A), a failover or rebalance can move an interface onto a switch that doesn't carry its VLAN. Its paths then go silent and are lost after KATO.
- A rebalance can strand an interface even without a failure (the simulator's "OVS-literal" toggle).
- To get the bond benefit, both storage VLANs have to be carried on both switches, which usually means crossing the ISL.
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
- A failure that keeps carrier up (a hung switch, a unidirectional link) is only detected by the LACP timeout: ≤3 s fast, up to 90 s slow. Flows hashed to the dead member blackhole until then.
- Switching to it requires a rolling host reboot.
- Field teams usually avoid LACP for storage, on the same reasoning as for iSCSI.

**Simulator:** `vs1-bond-mode: balance-tcp`, `lacp-rate`, `mlag`.

### C. One vswitch per fabric, "No Uplink Bond" (`per-fabric`)

**Shape:** two storage vswitches per node, each with one NIC to one switch and one storage interface (VLAN). There is no bond; NVMe multipathing alone handles failover.

**Pros**
- The simplest failure model, closest to classic iSCSI/NVMe host design: fail one port or switch and that fabric's paths are lost, while IO continues on the other fabric.
- Keeps the A and B fabrics truly independent, with no shared bond, LAG or MLAG.
- No risk of a stranded interface.
- Works naturally with isolated VLANs and storage VLANs kept off the ISL.

**Cons**
- Everpure's KB discourages no-bond modes (exceptions are allowed; check with the Nutanix team).
- A NIC failure always costs that fabric's paths, which a bond could otherwise have saved. Detection is at KATO (5 s), and in-flight IO on lost paths waits CQT (30 s) before retry.
- More vswitches and IP pools to configure.

**Simulator:** `storage-vswitch-layout: per-fabric`.

## Cross-cutting choices

| Choice | Options | Trade-off |
|---|---|---|
| VLAN placement (`vlan-placement`) | **Isolated** (VLAN A only on switch A, B only on B; default) vs **both VLANs on both switches** | Isolated keeps fabrics independent and is the typical storage design. Both-on-both lets a MAC-pinning bond save a path on NIC failure, but usually requires the ISL. |
| Storage VLANs on the ISL (`isl-storage-vlans`) | **Pruned** (default) vs allowed | Pruned keeps a single hop and avoids ISL latency and bottlenecks. Allowed (permitted by the Cisco Validated Design) adds redundancy for design A with both-on-both. |
| Switch-port mode | Node ports trunk, FA ports **access** (untagged) | It's simpler to tag on the switch side. An untagged CVM interface on an access port avoids most "network validation failed" setup errors. |
| MTU | 9000 everywhere (fabric 9216) vs 1500 | A mismatch anywhere fails large IO while small IO and keep-alives still work, which is hard to diagnose. Verify with `ping -M do -s 8972` (see `docs/commands.md`). |
| Flow control | Off (required) | PFC and global pause are not supported by the FlashArray for NVMe/TCP. |

## Same failure, three designs (isolated VLANs)

| Failure | A: MAC pinning | B: LACP + MLAG | C: per-fabric no-bond |
|---|---|---|---|
| One node NIC or cable | VLAN-A interface has nowhere to go, so its paths are lost after KATO. IO continues on VLAN B. | LAG survives on the other member. Paths survive if VLAN A reaches switch B through MLAG. | That fabric's paths are lost after KATO. IO continues on the other fabric. |
| One switch | All of one VLAN's paths are lost after KATO. | LAG survives; paths to FA ports on the dead switch are lost. | All of one fabric's paths are lost after KATO. |
| Hung switch (carrier up) | Paths through it are lost after KATO. | Flows hashed to it blackhole until the LACP timeout (≤3 s fast / ≤90 s slow), then move. | Paths through it are lost after KATO. |
| Worst case for a single IO | ≈ KATO + CQT (≈35 s), below the 60 s guest timeout | Slow LACP can exceed it | ≈ KATO + CQT (≈35 s) |
