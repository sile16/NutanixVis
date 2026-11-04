# OVS bond behavior on a two-switch storage network (balance-slb, MAC pinning)

How AHV's Open vSwitch (OVS) bond places, fails over and rebalances the CVM storage interfaces, and what that means for NVMe/TCP paths when the storage NICs of one bond go to two switches joined by an inter-switch link (ISL, vPC peer link or MLAG). Prism calls this mode "Active-Active with MAC pinning". It is the default storage bond in `storage-network-configs.md` design A.

The rules come from the OVS source (branch-3.3, which AHV 11.2 ships as 3.3.x). The scenarios are derived from those rules and from the initiator's path selector. Each claim is labeled `documented`, `source` (read in code), `inferred` or `assumption`.

## Sources

| Key | Source |
|---|---|
| OVS-BOND | [OVS `ofproto/bond.c` (branch-3.3)](https://github.com/openvswitch/ovs/blob/branch-3.3/ofproto/bond.c). Functions cited by name. Line numbers as read on 2026-11-03: `bond_check_admissibility` 873, `bond_account` 1140, `bond_shift_load` 1195, `choose_entries_to_migrate` 1227, `bond_rebalance` 1334, `get_enabled_member` 1974, `choose_output_member` 1992 |
| OVS-DOC | [OVS bonding topic](https://docs.openvswitch.org/en/latest/topics/bonding/) and [ovs-vswitchd.conf.db(5)](https://www.openvswitch.org/support/dist-docs/ovs-vswitchd.conf.db.5.txt) |
| AHV-ADMIN | Nutanix: *AHV Administration Guide* 11.2 (portal.nutanix.com), virtual switch bond types |
| SPDK-SRC | [SPDK `module/bdev/nvme/bdev_nvme.c`](https://github.com/spdk/spdk/blob/652aadef06e5c73d08e099f1b12ce3abcd42b50b/module/bdev/nvme/bdev_nvme.c), `_bdev_nvme_find_io_path_min_qd` |
| NET | [Network Configuration for NCP with FlashArray](https://support.everpuredata.com/r/nutanix/nutanix-everpure-bp-network-config) |

## The rules (balance-slb)

1. **Hash.** Each CVM storage interface is one bucket: `hash(source MAC, VLAN)` into 256 buckets (`source`, OVS-BOND `lookup_bond_entry`; OVS-DOC). The VLAN is part of the hash, so the same MAC tagged differently lands in a different bucket. The IP address plays no part. The bucket number is deterministic (hash basis 0) and survives reboots.
2. **Learn.** A bucket with no member, or whose member is down, takes the next enabled member **round-robin** (`get_enabled_member`: pop front, push back) (`source`). Two interfaces learned back to back therefore land on opposite members. Which one gets which depends on where the round-robin pointer stood, which looks random from outside. Learning happens at interface create, at host/OVS restart, and when an idle bucket expires (below).
3. **No VLAN awareness.** Placement, failover and rebalance never check whether a member can reach the bucket's VLAN (`source`: nothing in `choose_output_member` or `bond_rebalance` looks at the VLAN beyond hashing it). On isolated storage VLANs (node ports that carry only one VLAN each) a bucket can be placed on a member that blackholes it, and the bond still counts that member as healthy.
4. **Failover.** Carrier loss disables a member at once. Its buckets move to the survivor (`documented`, OVS-DOC).
5. **Load is transmitted bytes only.** `bond_account` adds the bytes the host *sends* through the bond (`source`). For NVMe/TCP that is write data plus command capsules and ACKs. Read data arrives as received traffic and does not count, so a read-heavy interface looks light.
6. **Smoothing.** After every rebalance pass each bucket's byte count is halved (`e->tx_bytes /= 2`; an idle bucket decays to zero and is deleted after about 20 passes) (`source`). The load the rebalance sees is an exponentially weighted history with a half-life of one interval, not the last interval alone.
7. **Rebalance interval.** AHV sets `bond-rebalance-interval` to 30 s on its balance-slb bonds. The OVS default is 10 s (`assumption`: read on an AHV 11.2 host; not in AHV-ADMIN).
8. **Rebalance decision**, from the most-loaded member *from* to the least-loaded *to* (`source`, `bond_rebalance` and `choose_entries_to_migrate`):
   - Nothing moves if *from*'s extra load over *to* is under about 3 % of *to*'s or under 100,000 bytes (smoothed).
   - **Nothing moves off a member that carries a single bucket** (`ovs_list_is_short`: "shifting load away from it would be pointless"). A split with one interface per member is therefore never rebalanced again.
   - Otherwise *from*'s buckets are taken heaviest first, each one only if it still fits within half the gap. When *to* is empty and *from* has two buckets, **the heavier one is more than half and is skipped, so the lighter one moves**.
   - The move only happens if the lighter bucket is at least a tenth of the ideal shift, i.e. **≥ 5 % of the total when *to* is empty**.
9. **Broadcast and multicast are accepted only on the active member** unless `all-members-active` is set (`source`, `bond_check_admissibility`: "Drop all multicast packets on inactive members"; OVS-DOC). Unicast is accepted on any member.
10. **No pinning control in AHV.** `ovs-appctl bond/migrate <bond> <hash> <member>` moves a bucket by hand, and `bond/set-active-member` picks the active member. Neither is exposed in Prism or `acli`, and neither survives an OVS restart (`assumption`).

For contrast, **balance-tcp** (Prism "Active-Active", LACP required) hashes each flow's L3/L4 5-tuple (`source`, `flow_hash_5tuple`), so one CVM's NVMe/TCP connections spread over both members. With LACP negotiated it accepts broadcast and multicast on every enabled member (`source`, the `LACP_NEGOTIATED` case of `bond_check_admissibility`). AHV-ADMIN: LACP fast and fallback to active-backup are forced.

## The initiator side (why one interface is heavier)

The CVM's NVMe/TCP initiator is modeled with a minimum-queue-depth selector (`inferred`; `profile-coverage.md`, `externalStorage.pathSelector`). In SPDK's `_bdev_nvme_find_io_path_min_qd` each IO goes to the path with the fewest outstanding IOs, and a tie goes to the path found first in the list, i.e. attached first (`inferred` from SPDK-SRC). Three effects follow, and they decide which storage interface is heavier at the moment a rebalance looks:

| Effect | When it dominates | Which interface it makes heavier |
|---|---|---|
| **First-path priority** (tie-break) | Low IO rate: queues are mostly empty, so every IO is a tie | The interface whose paths were **attached first**. Paths re-attached after an outage are last, so a recovering interface carries little. A restart of the initiator can reorder the list. |
| **Extra-hop latency** (ISL) | Sustained IO with queues: equal outstanding counts mean each path's rate is proportional to 1 / latency (Little's law) | The interface that does **not** cross the ISL. On a healthy cut-through ISL the extra hop is microseconds against an array latency of hundreds of microseconds, so the effect is a few percent at most; under ISL congestion it becomes large. |
| **IO mix** (rule 5) | Always, because the bond counts transmitted bytes | The interface carrying more **write** bytes. Read-heavy traffic barely counts. |

**How big is the extra hop?** (`inferred` from typical published switch figures; not measured here.) Crossing the ISL adds one switch traversal and one link:

| Component | Typical |
|---|---|
| Extra cut-through switch traversal | ~0.3–1 µs (data-centre ToR merchant silicon ~0.5–1 µs; ultra-low-latency switches 50–300 ns) |
| Store-and-forward when the egress is slower than the ingress (100 G ISL into a 25 G host or array port) | + one frame serialization: 0.5 µs (1500 B at 25 G) to 2.9 µs (9000 B at 25 G) |
| Frame serialization on a 100 G ISL | 0.1–0.7 µs (1500–9000 B), only if that hop stores and forwards |
| Cable propagation | ~5 ns/m, tens of ns |
| **Extra per one-way trip** | **≈ 0.5–1.5 µs** cut-through, **up to ~3–4 µs** with jumbo frames and store-and-forward |

An NVMe/TCP IO crosses twice (command and completion or data), so it gains about 1–3 µs (up to ~8 µs), against an array IO latency of the order of 100–300 µs: **about 1 %, a few percent at most**. On a healthy ISL the extra-hop effect therefore shifts only about 1 % of the IO under a minimum-queue-depth selector, too little to decide which interface is heavier; first-path priority and the write mix decide. It matters only under congestion: ISL buffer queueing (1 MB at 100 G ≈ 80 µs) adds tens to hundreds of µs and then clearly lightens the crossing interface.

The rebalance takes the decision at the first 30 s pass at which the smoothed loads clear the thresholds of rule 8, and with two interfaces it is final once they are split (rule 8, single bucket). Later congestion on the ISL cannot undo it.

### Share thresholds, one bucket per interface, both on member *M*, the other member just restored

With *s* = smoothed share of interface X of the bytes on *M* (Y has 1 − s):

| s | Outcome at the next rebalance |
|---|---|
| < 5 % | Nothing moves. X stays on *M* (both share one link). |
| 5–50 % | **X moves** to the restored member. |
| 50–95 % | **Y moves** to the restored member. |
| > 95 % | Nothing moves. |

Because of the halving (rule 6), an interface whose traffic restarts from zero is measured at about half its true share at the first pass after it restarts. Its measured share rises through 5–50 % on the way up, so a recovering interface that ramps up usually moves (row 2). It only skips straight to row 3 if it jumps to more than about 95 % of the bytes within one interval.

## Scenarios: node trunk ports, array access ports, isolated per-switch array VLANs

Layout: eth2 → switch 1, eth3 → switch 2; both node ports trunk VLAN A and B; array ports for VLAN A on switch 1 only, VLAN B on switch 2 only (the "trunk links" option where only the node side trunks). Interface `ntnx0` = VLAN A, `ntnx1` = VLAN B. **Home** = each interface on the member facing its own array ports (`ntnx0` eth2, `ntnx1` eth3): no storage traffic on the ISL. **Worst** = both on the far member (`ntnx0` eth3, `ntnx1` eth2): **100 % of storage traffic on the ISL**, and it stays that way until the next link event (rule 8).

| # | Event sequence (start: home) | What decides it | Outcome |
|---|---|---|---|
| S1 | **Switch 1 fails, returns hours later** | During the outage the VLAN A array ports are gone too, so `ntnx0` is idle (light). At recovery `ntnx0` reconnects from zero, attached last, across the ISL: all three effects make it lighter. | `ntnx0` moves home at the first pass where its share is ≥ 5 % (within about 30–60 s of IO). **Not worst.** |
| S2 | S1 at a **very low IO rate** | First-path priority gives `ntnx0`'s re-attached paths almost nothing (< 5 %), or the total is under 100 kB per interval. | Nothing moves; `ntnx0` stays on eth3 and crosses the ISL **for as long as its share stays under 5 %**. It moves home once load rises gradually through 5–50 %. Latent, not locked. |
| S3 | **Node NIC, cable or switch port on eth3 fails** (switch 2 alive), restored later | The VLAN B array ports are still reachable over the ISL, so `ntnx1` stays busy on eth2 during the outage. At restore the **lighter** interface moves to eth3. If `ntnx1` is the heavier one (first-path priority, more writes), **`ntnx0` moves**. | **Worst, locked**: `ntnx0` eth3 and `ntnx1` eth2, both crossing the ISL. Probability ≈ P(`ntnx1` heavier at the first pass), which is close to 1 with a persistent first-path or write asymmetry, and roughly ½ when the loads are balanced and the ISL is healthy. |
| S4 | Same as S3 but on **eth2** (the lighter interface's member) | `ntnx0` stays lighter, moves back to eth2 at restore. | Home. Flapping the lighter interface's link restores the layout; flapping the heavier one's link swaps it. |
| S5 | S3 with a **congested ISL** during the outage | Extra-hop latency on `ntnx1`'s paths shifts IO to `ntnx0`, so `ntnx1` turns lighter. | `ntnx1` moves home. **Self-correcting, but only if the congestion exists before the first pass after restore.** |
| S6 | **Worst state, then the ISL fails** (or a vPC peer link fails and the ports stay up) | Every path of both interfaces crosses the ISL; carrier stays up on both members, so the bond does nothing. | **All storage paths of every node in that state are lost** while every NIC and both switches are up. The array is still reachable on the same switches through the other member, unused. |
| S7 | **Switch 2 reboots** (all nodes at once) | As S1 for `ntnx1` on every node. | Home on every node at recovery, unless S2 conditions hold. |
| S8 | **Host or OVS restart** | Rule 2: the two buckets are learned again round-robin. | Split at random: home or worst, **about ½ each**, independent of the previous state. |
| S9 | **Interface re-created** (VLAN change, re-attach) | Rule 2 for one new bucket. | Lands on whichever member the round-robin pointer gives it: right or wrong side about ½. |

Two regularities:

- **Only the last flap matters.** After any flap and restore with real traffic, the lighter interface ends up on the restored member. Earlier history does not change that.
- **A switch failure is gentler than a NIC failure.** When a switch dies, the displaced interface loses its targets too, goes idle, and is the light one at recovery, so it goes home. When only the node-side link dies, the displaced interface keeps working over the ISL, and whether it comes home depends on who is heavier.

### Access ports (node ports carry one VLAN each)

With isolated VLANs on the node ports, rule 3 turns every placement mistake into a dead interface instead of an ISL detour:

- **Any single-link flap strands an interface.** The displaced interface fails over onto a member that cannot reach its VLAN and goes dark. Its load drops to ARP retries, far below 5 %, so rule 8 never moves it back after the restore. Recovery needs a manual `bond/migrate`, a flap of the other link (which strands the other interface instead), or a restart.
- **Only one VLAN can sit on the active member** (rule 9). The interface on the other member reaches the array (its own ARP requests go out, the array's replies are unicast) but cannot answer ARP broadcasts from its peers. Anything that needs peer-to-peer reachability on that segment fails, including the CVM-to-CVM RPC check that the interface-create workflow runs (`assumption` for the workflow; see below).
- **The interface-create check does not test the array.** The External Storage interface create validates the new segment with a CVM-to-CVM RPC test, not with a ping to the array portals (`assumption`, lab observation). An interface that reaches its peers but not the array passes.

### Array ports trunked too (each array port has an address in both VLANs)

Each VLAN then has targets on both switches. Wherever an interface is pinned, about half of its paths are local (`inferred`; with the extra-hop effect, a little more than half the IO goes local). Swaps and lock-ins still happen, but they no longer change the ISL share, and an ISL failure costs half of each interface's paths, not all of them.

## What follows for designs and the simulator

- **The ISL detour is a resilience problem first and a performance problem only at the bandwidth limit.** The extra hop costs about 1 % of IO latency; it shows only when the ISL is oversubscribed (sustained load or microbursts, especially if the ISL also carries live migration or backup traffic). What it always changes is the fault domain: in the worst state every storage path of the node depends on the ISL (S6), and on access ports a misplaced interface is not slower but dead.
- **MAC pinning plus array access ports plus a two-switch storage network** has a stable worst state that is reached by an ordinary node-side link event (S3) and broken only by another link event or a manual move. Nobody is alerted: every member is up. Treat "storage interface on the far member" as something to monitor (`ovs-appctl bond/show` per host) after any storage-link event.
- Designs that do not have it: **one vswitch per fabric with no bond** (placement fixed; NVMe multipath does the failover), **array ports trunked** (ISL share bounded), and **LACP balance-tcp with MLAG** (per-flow hashing, broadcast on every member).
- Simulator (`src/engine/network/bond.ts`): see `docs/STATUS.md` "Behavior to double-check" for the gaps between the current bond model and these rules.
