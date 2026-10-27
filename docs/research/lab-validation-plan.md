# Lab validation plan (test drive instance)

**Goal:** turn the `assumption`- and `unverified`-labeled rules in the profile into **`lab-observed`** rules. Each one records the AOS, AHV and Purity//FA versions it was measured on, the method, and the date. Results become golden expectations in the matching scenario files.

**Status:** waiting on lab access details and the owner's confirmation of which disruptive actions are allowed (see "Questions").

## Lab constraints (known)

- **Single NIC per node, so no uplink bond.** Bond experiments (L4, the bond part of L12, and L13) **can't be run in this lab**. They stay simulator-only (`inferred` / `assumption`) until a bonded lab is available.
- **Array-side failure injection.** Add **extra FA data IPs** (more interfaces, or VLAN interfaces per controller) so each CVM has more paths. Then fail individual paths by disabling single FA IPs, without touching the node's only NIC.
- **Node-side path loss without isolating the node.** Prune the storage VLAN on one node's switch port, which requires switch access. Management stays up on the same NIC. This is the realistic way to run L1 and L2 here.
- The simulator has a matching **T1-lab** topology, so results can be compared directly.

## Method (common to all experiments)

- **Clocks.** NTP-sync everything (CVMs, hosts, FA, test VM) and record timestamps to the second.
- **Workload.** Run one Linux test VM per node with `fio`: mixed 4k random read/write plus 1 MiB sequential, `--write_lat_log` / `--log_avg_msec=1000`. That gives an IO timeline with 1 s resolution, so stalls are measured where the guest sees them.
- **What to collect per run:**
  - the fio latency and IOPS timeline
  - Prism alerts and tasks
  - HA status transitions
  - Stargate and redirector logs on the affected node
  - Purity alerts and audit log
  - the time the failure was injected
- **Repeats.** Run each experiment at least 3 times and report the median and range.
- **Output.** Add a row per experiment below, then update `profiles/*.ts` with `confidence: 'lab-observed'`, plus `{aos, ahv, purity, date}`.

## Experiments, by gap

| # | Gap it closes | Injection | Measure |
|---|---|---|---|
| L1 | **One CVM loses all array paths while Stargate stays alive.** Does the redirector move IO to a remote CVM, or does IO retry until the array responds? | Prune the storage VLAN(s) on that node's switch port. Management stays up on the same single NIC. | VM IO timeline. Whether a remote Stargate took the vDisk (Stargate logs). HA events. |
| L2 | **Default and range of the per-VM force-shutdown timeout**, and what happens when it fires | Repeat L1 with the timeout set on the test VM | When the VM shut down, and when it restarted on another node |
| L3 | **How long IO stalls during a redirect** | `genesis stop stargate` on one CVM, then a separate run that powers off the CVM | VM IO gap length. Time until failback after the restart (expect about 30 s stable). |
| L4 | *(needs a bonded lab; N/A on single-NIC)* **Bond failover on `vs1` with MAC pinning** (no NVMe path loss expected) | One `vs1` uplink down, then one switch-side port down | VM IO gap. Whether any NVMe path drops (Stargate / SPDK logs). |
| L5 | **NVMe keep-alive and path-loss detection** (FA side) | Disable one FA data IP or interface (extra IPs added for this) | Time until the path is marked lost. IO continuity. Time until reconnect after re-enable. |
| L6 | **FA planned controller failover** (expect ≤15 s pause) | Purity planned failover, support-assisted if the lab requires it | VM IO gap. Which paths disappear and return. |
| L7 | **AHV HA timeline** (expect T+20 / T+60 / T+120) | IPMI power-off of one host | When the fence happened and when VMs restarted. HA status OK → Healing → Critical/OK. |
| L8 | **Host network isolation** (expect self-terminate 45 s after the first failed IO) | All uplinks on one node down | VM state on the isolated host. When the VM restarted elsewhere. |
| L9 | **Node-failure tolerance N−2 / N−3** (cluster size dependent) | Power off 2 hosts at once on a 4-node cluster | Service recovery time. That no manual intervention was needed. |
| L10 | **FA management API unreachable** (running IO should be unaffected) | Block the FA mgmt VIP from the CVM network | That IO continues. Which tasks fail, and their error text. |
| L11 | **MTU mismatch** | Set the switch MTU to 1500 with endpoints at 9000 | Small-IO vs large-IO behavior. Alerts raised. |
| L12 | **Multipath policy and path usage for one vDisk** (active-active vs active-passive; IO queues per path) | One VM, one vDisk, steady fio. Repeat under each `vs1` bond mode the lab allows. | Per-FA-port IO for that host (Purity per-port stats). CVM TCP connections to the FA ports (`ss`). Per-uplink counters (`ovs-appctl bond/show`, NIC stats). |
| L13 | **MAC-pinning pinning and rebalance**: whether both storage vNICs land on different uplinks, and how fast a rebalance happens | Steady load, then skew load onto one vNIC | `ovs-appctl bond/show` hash-to-member over time |

## Questions for the owner

1. **Access.** How do we reach the test drive (VPN or jump host, Prism and Purity credentials), and is it shared or dedicated?
2. **Topology.** How many nodes, which switch access, IPMI access? Which AOS, AHV and Purity//FA versions does it run?
3. **Allowed disruption.** Which of L1–L11 may we run? In particular: switch port shutdowns, IPMI power-off, Purity controller failover, and CVM/Stargate stops.
4. **Publishing.** May lab-measured timings be published in the public repo, labeled `lab-observed` with versions? Some of them, such as initiator timers, may match values that are otherwise documented only internally.
5. **Automation.** Should we build a scripted harness (inject → wait → collect logs) so the experiments can be re-run against new releases and new version profiles?
