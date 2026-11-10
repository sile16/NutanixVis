# View-field contract

Status: **proposed by stream H (scenarios)**, for adoption by the integrator. This file lists the `DeviceView.fields` keys, the `Snapshot.derived` keys and the event codes that the scenario acceptance tests (`src/scenarios/**`) read. Domain streams E, F and G must produce them.

**Scope.** The contract is minimal on purpose. Producers may add more fields for the inspector, but they must not rename or retype the fields listed here.

**How it is read.** `src/scenarios/helpers.ts` holds the typed readers. A missing or mistyped field throws with the device id and key, so contract drift fails loudly instead of quietly evaluating to `false`.

## Conventions

- **Field values** are `ViewField` (`string | number | boolean | null`).
  - Lists and maps are **JSON-encoded strings**, for example `'["node-1.eth3"]'`.
  - `null` means "not applicable here": for example `nvmePathsUp` on an HCI CVM, or `lacpRate` on a non-LACP bond. JSON fields may be `null`, which reads as empty.
- **Times** are simulated seconds. A field named `…S` is a duration in seconds.
- **VM ids are stable.** A VM keeps its id (`node-<n>.vm-<m>`) after an HA restart on another host, and its `host` field says where it runs now. `DeviceView.parent` may follow `host` for rendering, but tests read `host`.
- **NVMe path id:** `<cvm-interface id>~<fa-interface id>`, for example `node-1.cvm.storage-a~fa.ct0.eth10.v10`.
- **Timing.** An action queued at simTime `t` applies at the start of tick `t+1` (`Simulation.applyAction`), so its effect first shows in snapshot `t+1`. Scenarios inject at `t=10` (`T0`) and allow `SLACK = 2` ticks around modeled timers.

## Device fields

**Every device** may also carry, when it or an ancestor is failed: `status: 'failed'`, `down: true` and `downReason` (`"failed"` for the device itself, `"<ancestor id> failed"` for anything under it). A link is reported `down` when the device at either end is down.

### `vm`

| Key | Type | Meaning |
|---|---|---|
| `state` | `running` \| `io-stalled` \| `paused` \| `crashed` \| `restarting` \| `off` | `running`: some of its IO completes, possibly with latency outliers (SPEC §6.4c). `io-stalled`: alive, but none of its IO completes and it has outstanding IO at least one tick old (a just-issued IO is not a stall). `paused`: suspended by the hypervisor. `crashed`: its process died unexpectedly (host power loss, self-termination). `restarting`: an HA restart is in progress. `off`: powered off, or force-shut down. |
| `host` | string \| null | AHV host it runs on now; `null` when no process exists. |
| `placedBy` | `topology` \| `ha-restart` \| `live-migration` \| `power-on` | How it came to run on its current (or last) host: where the topology placed it, an AHV HA restart, a live migration (host maintenance mode), or a power-on. The diagram's moved-VM marker and the inspector's placement line word it by this. |
| `placedFrom` | string \| null | The host it ran on before that move; `null` for `topology`. |
| `instances` | JSON string[] | Hosts with a live QEMU process for this VM. Normally 0 or 1. The "no VM runs twice" invariant checks that it has ≤ 1 entry. |
| `ioPendingS` | number | Age of its oldest outstanding IO (0 when nothing is outstanding). This measures the worst-case wait of a single command. |
| `stuckIoPct` | number | Share of the guest's IO slots (queue depth × vDisks) held by IO that is stuck rather than in flight, in % (0–100). Below 100 with `running`: a partial stall, as when a silent path loss under the queue-depth selector strands only the commands on the dead path's queues. 100 with `io-stalled`: all of its IO is stalled. |
| `readPendingS` | number | The same, for reads only. |
| `writePendingS` | number | The same, for writes only (for example, writes waiting on RF replication). |
| `ownerCvm` | string \| null | CVM whose Stargate serves its vDisks: the local CVM normally, a remote one after a redirect, and always remote on CO nodes. |
| `vdisks` | JSON string[] | Its vDisk ids (one AOS vDisk per FlashArray volume in T1). |
| `outstandingIo` | number | Guest IOs of the sampled IO model issued and not yet completed (in flight or stuck). |
| `restartNeed` | `none` \| `ha` \| `next-cycle` | Whether AHV HA owes it a start: `ha` after its host is fenced, `next-cycle` at the next HA cycle (a force-shutdown, or an initiator timeout while its host is still connected). |
| `ioPaths` | JSON string[] | T1 only: NVMe path ids that carried this VM's vDisk IO during the last tick. |
| `ioUplinks` | JSON string[] | Physical NICs, on any host, that carried this VM's storage IO (iSCSI or NVMe/TCP) during the last tick. It is empty for HCI VMs served locally over `virbr0`, and while the VM is not running (paused, off, crashed, restarting). |
| `ioLatencyMs` | number \| null | Latency of its last completed IO (sampled model); `null` while it is not running. With the throughput model the inspector shows `ioLatencyUs` instead. |
| `ioChain` | JSON object | The VM's IO path as ordered hops, for drawing: `{vm, stalled, remote, selector, hops:[{role, ids, label, via?}]}`. Roles in order: `vm`, `redirector` (the AHV iSCSI redirector, Frodo; `via` lists the host NICs the iSCSI leg crosses when the CVM is remote), `cvm`, `stargate` (inside the CVM; the SPDK NVMe/TCP initiator on T1), `nic` (the CVM's storage NICs that carried IO), `array-port` (FlashArray interfaces reached). `selector` is the path selector among optimized paths (T1, e.g. `queue-depth`). HCI VMs end at `stargate`. `src/domain/steps` exports `ioChainOf`. |
| `pathLossForceShutdownS` | number \| null | Optional. The per-VM force-shutdown timeout on storage path loss (T1); `null` means unset (retry forever). |
| `offeredLoad` | number \| `line-rate` | T1 throughput model (`docs/research/link-congestion.md`): the VM's offered storage load in Gb/s; `line-rate` = no cap. Set by option `vm-load-gbps` or action `vm.set-load`. Present on every VM of the model, running or not (with `offeredIops` and `readPct`). |
| `readPct` | number | T1 throughput model: read share of the load, %. |
| `offeredIops` | number \| null | T1 throughput model: the offered load in IOPS (`offeredLoad` ÷ IO size); `null` for `line-rate`. |
| `throughputGbps`, `readGbps`, `writeGbps`, `iops` | number | T1 throughput model: the rate the VM achieves (read + write, and each), after NIC and link limits. Present while the VM has a process (`host` set); 0 unless its state is `running` (a paused or `io-stalled` VM moves no data). A partial stall (`stuckIoPct` below 100) leaves only the free share of its queue in flight. A path whose route is not yet (or no longer) known carries nothing; the rest of the VM's paths carry its flow. |
| `ioLatencyUs` | number | T1 throughput model: mean round-trip latency of one IO, µs, including queueing on congested links. Absent while the VM moves no data. |
| `flowPaths` | JSON array | T1 throughput model, per NVMe path: `{id, gbps, latencyUs, islPct, routes:[{pct, out, back}]}`. `out` and `back` name the hops each way, marking a switch-to-switch hop `⇒ ISL ⇒` and a full direction `[full +N µs]`. The inspector's "Storage throughput" section shows it. |

### `cvm`

| Key | Type | Meaning |
|---|---|---|
| `state` | `up` \| `down` | The CVM itself, powered on or not. |
| `stargate` | `up` \| `down` \| `unhealthy` \| `hung` | The Stargate process. `unhealthy`: running but failing (for example, ZK or metadata unavailable). `hung`: alive but answering neither IO nor NOPs (`cvm.hang-stargate`). |
| `nvmePathsUp` | number \| null | T1: count of `live` paths. `null` outside T1. |
| `nvmePathsTotal` | number \| null | T1: count of configured paths, live or not. |
| `nvmePathsInaccessible` | JSON string[] | T1: live paths whose controller reports ANA Inaccessible (it drains for a planned reboot). They carry no new IO until they reconnect. |
| `nvmePaths` | JSON Record<pathId, `live` \| `lost` \| `removed`> | T1: per-path state. `lost`: keep-alive expired, the target reset the connection, or an IO timeout reset the path; reconnecting every `reconnectDelayS`. `removed`: the controller was deleted after `controllerLossTimeoutS`. |
| `nvmePathLatencyMs` | JSON Record<pathId, number \| null> | T1: latest IO completion latency seen on each path (network + array service, illustrative); `null` before any. The queue-depth selector weighs it (SPEC §6.4c "Slow link"). |
| `nvmePathIoShare` | JSON Record<pathId, number> | T1: share (%) of this CVM's IO commands sent on each path over the last 30 s. |
| `zkMember` | boolean | It holds a Zookeeper ensemble seat. |
| `zkQuorum` | boolean | It is in a partition that has a ZK majority. |
| `zkPartition` | string \| null | Stable id of its network partition (for example, the lowest CVM id reachable). The "unique quorum side" invariant groups by this. |
| `ringState` | `normal` \| `down` \| `detached` \| `forwarding` | Cassandra ring membership. `detached`: auto-removed after `cassandraRingDetachS`. `forwarding`: Degraded Node Detection disabled its metadata store (it holds no live replica). |
| `internalLink` | `up` \| `down` | The host-internal link between the AHV host and this CVM (`cvm.internal-link-down` / `-up`). |
| `plannedShutdown` | `none` \| `preparing` \| `off` | Planned shutdown (`cvm.planned-shutdown`): `preparing` while traffic is forwarded away and services stop, `off` once powered off; it stays off until `cvm.planned-start`. |
| `dndState` | `ok` \| `scoring` \| `degraded` | Degraded Node Detection (SPEC §6.2). `scoring`: its peers found it unresponsive and the `dnd.scoringWindowS` window is running. `degraded`: marked Degraded until `dnd.autoResolveHealthyS` of health or `cvm.mark-fixed`. |
| `hades` | `ok` \| `maintenance` \| `restarting` | T1 Hades state (SPEC §6.2). `maintenance`: every path to the CVM's service volumes was lost and the error lasted `hades.externalStorageErrorThresholdS`, so its services are stopped (`stargate` is `down`). `restarting`: a volume check found the mounts healthy again, the node left maintenance and the services are restarting (`hades.servicesRestartS`). Always `ok` outside T1, or with `hades-maintenance-on-storage-error: off`. |
| `ownedVdisks` | number | vDisks its Stargate holds (has acquired) now. |
| `backend` | `external-nvme` \| `hci` | Its storage backend: the FlashArray over NVMe/TCP (T1), or the HCI extent store. |
| `backendHealth` | `ok` \| `degraded` \| `unavailable` | The backend's own health. T1: `degraded` while some path is not live or a controller reports ANA Inaccessible, `unavailable` with no live path. HCI: `unavailable` without metadata or any reachable replica, `degraded` while data is unavailable, under-replicated or read-only. |
| `nvmeHealth` | `ok` \| `degraded` \| `unavailable` | T1: the NVMe/TCP initiator's view, the same rule as `backendHealth`. |
| `nvmeMultipathPolicy` | `active-active` \| `active-passive` | T1: the profile's `externalStorage.multipathPolicy`. |
| `nvmePathSelector` | `queue-depth` \| `round-robin` | T1: the selector among optimized paths (`externalStorage.pathSelector`). |
| `nvmeIoInflight`, `nvmeIoHeld`, `nvmeIoQueued` | number | T1: initiator commands by state: sent on a path, held after a path loss (until the retry), or waiting for a live path. |
| `nvmeReservations` | JSON string[] | T1: vDisks whose NVMe reservation this CVM holds. |
| `hci.replicas` | number | HCI: healthy extent-group replicas stored on this CVM's disks. |
| `hci.ioPending` | number | HCI: IOs its Stargate has in progress (waiting on a local disk or on replica acks). |
| `hci.vdisksOwned` | number | HCI: vDisks its Stargate owns. |
| `hci.readOnly` | boolean | HCI: the cluster is read-only (physical usage at `hci.readOnlyCapacityPct`); also in `Snapshot.derived`. |

### `cvm-interface` (schema fields, echoed into the view)

| Key | Type | Meaning |
|---|---|---|
| `service` | `mgmt` \| `external-storage` \| `backplane` | Used to count a CVM's storage vNICs. |
| `vlan` | number | |
| `ip` | string | Schema value. |
| `vswitch` | string \| null | The vSwitch it attaches to (schema). Host interfaces (`host-interface`) carry the same `ip` and `vswitch` fields. |

### `ahv-host`

| Key | Type | Meaning |
|---|---|---|
| `power` | `on` \| `off` | |
| `role` | `hci` \| `compute-only` \| `storage-only` \| `external-storage-compute` | Schema role. |
| `haState` | `connected` \| `disconnected` \| `fenced` | The Acropolis leader's view of the host. `disconnected`: heartbeats are missing. `fenced`: Stargates block its IO, from T+60. It returns to `connected` once the host rejoins. |
| `maintenance` | boolean | AHV maintenance mode (`host.enter-maintenance`): unschedulable, its VMs migrated off. |
| `block` | string \| null | Its block (chassis) id, for block awareness. |
| `cvm` | string \| null | Its CVM id (`null` on a compute-only node). |
| `rebooting` | boolean | A host reboot is in progress. |
| `isolated` | boolean | `host.isolate` has cut its network links. |
| `sessions` | JSON Record<vdiskId, string> | The AHV redirector's iSCSI session per vDisk: the serving CVM, `<cvm> (external)` when it uses that CVM's external portal, `<cvm> (parked)` while logged in but not yet served, or `none`. |
| `unhealthyStargates` | JSON string[] | CVMs the redirector currently counts unhealthy (unanswered NOPs, not yet answering again). |
| badges | — | The `acropolis-leader` badge appears on the leader host; `maintenance` on a host in maintenance mode. |

### `vswitch` (engine view kind: `bond`)

The engine reports AHV virtual switches with view `kind: 'bond'`; the UI and scenario helpers treat `bond` and `vswitch` as the same kind.

| Key | Type | Meaning |
|---|---|---|
| `bondMode` | `active-backup` \| `balance-slb` \| `balance-tcp` \| `no-bond` | Current mode, which changes at runtime with `vswitch.set-bond-mode`. |
| `lacpRate` | `fast` \| `slow` \| null | `null` unless `balance-tcp`. |
| `lacpState` | `negotiated` \| `partial` \| `fallback` \| `down` \| null | `partial`: some members are not aggregated (for example, a partner mismatch without MLAG, or one member's LACP timed out). `fallback`: no member is negotiated, so `lacp-fallback-ab` runs active-backup over every member with carrier. `down`: no member left (fallback off, or no carrier). `null` unless `balance-tcp`. |
| `members` | JSON string[] | Configured member NICs. |
| `activeMembers` | number | Members currently carrying traffic. A member on a hung switch stays counted until LACP detaches it. |
| `activeMember` | string \| null | The active member under active-backup or no-bond, or under balance-tcp in LACP fallback; otherwise `null`. |
| `initialActive` | string \| null | Active-backup only: the member pinned with `bond/set-active-slave` (topology option `vs0-active-member: alternate`), preferred whenever the bond picks a new active member. `null`: OVS default, the first linked member. |
| `pinning` | JSON Record<vnicId, nicId> | Which member each vNIC egresses on. vNIC ids are cvm-interface ids, host-interface ids or VM ids. It covers balance-slb, active-backup and no-bond, and is empty for balance-tcp, which is per-flow. |
| `net` | `bond` | Engine element type. |
| `mode` | as `bondMode` | Engine name for `bondMode`. |
| `uplinks` | string | Comma-separated uplink NICs in use (`vswitch.set-uplinks` may drop some of `members`). |
| `eligible` | string | Comma-separated members that may carry traffic now (carrier, LACP aggregated). |
| `misconfig` | string \| null | A detected misconfiguration, e.g. `lacp-no-mlag`: the uplinks reach two LACP partners without a shared MLAG domain. |
| `group` | string | The vSwitch name: bonds of one group change mode and LACP rate together, cluster-wide (SPEC §5.5). |
| `active` | string \| null | Engine name for the single active member (active-backup, no-bond, LACP fallback). |
| `member.<nic>` | `up` \| `active` \| `backup` \| `down` \| `detached` \| `lacp-down` \| `unused` \| `not-uplink` | Per member: `detached` is outside the LACP aggregator (another partner), `lacp-down` timed out its LACPDUs, `unused` is the second NIC of a no-bond vSwitch, `not-uplink` is not in `uplinks`. |
| `buckets.<nic>` | number | Hashed modes (balance-slb, balance-tcp), not in fallback: hash buckets pinned to each member. |

### `nic` (host NICs and FA ports)

| Key | Type | Meaning |
|---|---|---|
| `link` | string \| null | The id of its cable (`null` if uncabled). Carrier is that cable's status. |
| `net` | `nic` | Engine element type. |
| `mtu` | number | |
| `adminUp` | boolean | `false` after `fail` (admin down or failed). |
| `hung` | boolean | `hang`: carrier stays up, frames die (LACPDUs may keep flowing). |
| `bond` | string \| null | The vSwitch (bond) it is a member of. |
| `speedGbps` | number | |

### `switch`

| Key | Type | Meaning |
|---|---|---|
| `state` | `up` \| `failed` \| `hung` | `hung`: stops forwarding but keeps carrier on every port (`switch.hang`). |
| `vlans` | string | Comma-separated VLANs carried. |
| `flowControl` | `off` \| `global-pause` \| `pfc` | |
| `net` | `switch` | Engine element type. |
| `mtu` | number | |
| `adminUp` | boolean | |
| `hung` | boolean | `switch.hang`. |
| `mlagDomain` | string \| null | Its MLAG domain while MLAG is on; `null` otherwise. |

### `fa-array`

| Key | Type | Meaning |
|---|---|---|
| `ioServing` | boolean | `false` during an array-wide IO pause. |
| `pauseS` | number | How long the current array-wide pause has lasted (0 while serving). |
| `primary` | string \| null | Controller id holding the primary role; `null` while none does, for example mid-promotion. |
| `mgmtApi` | `up` \| `unreachable` | Management API (`fa.vir0`) reachability from the cluster. |
| `model` | string | Array model (schema), e.g. `FlashArray//X70`. |
| `promoting` | string \| null | The controller being promoted to primary, mid-failover. |
| `ndu` | `reboot-secondary` \| `await-hosts` \| `failover` \| `reboot-primary` \| null | The NDU phase (`fa.ndu`); `null` when none runs. |
| `heldIo` | number | Commands the array holds (array-wide pause or a stalled controller), answered once it serves again. |
| `reservations` | number | NVMe reservations held on its volumes. |
| `promotionS` | number | Duration of a crash promotion (`flasharray.primaryCrashPauseS`, bounded by claim-expiry detection plus `promotionMaxS`). |

### `fa-controller`

| Key | Type | Meaning |
|---|---|---|
| `role` | `primary` \| `secondary` \| `promoting` \| `offline` | |
| `state` | `up` \| `draining` \| `crashed` \| `rebooting` \| `stalled` | `stalled`: alive but not completing IO (`fa.io-stall`). `draining`: a planned reboot's first phase; new IO is answered ANA Inaccessible, in-flight IO finishes. |
| `slot` | `ct0` \| `ct1` | Schema value. |
| `hosts` | number | Host initiator endpoints this controller has heard from (connect or keep-alive), each counted once. |

### `fa-interface`

| Key | Type | Meaning |
|---|---|---|
| `nic` | string | The port it lives on (schema). |
| `vlan` | number | Schema value. |
| `service` | `nvme-tcp` \| `mgmt` \| `replication` | Schema value. |
| `enabled` | boolean | Admin state (`fa.interface.disable` / `enable`). |
| `oper` | `up` \| `down` | `down` if disabled, if its port has no carrier, or if its controller is not `up`. |
| `cabled` | boolean | `false` when its port has no cable (the topology option `array-data-ports: first-only`): not connected by design, status `offline`, no NVMe path to it. |
| `ip` | string | Schema value. |
| `floating` | boolean | `true` for the floating management VIP (`fa.vir0`), drawn in the controller that holds it (its `nic` follows the primary). |

### `throughput-model` (`flows`, T1)

A logical device (not drawn). `links`: JSON `{linkId: [{from, to, gbps, capacityGbps, delayUs, dropGbps}]}`, one entry per direction, from the throughput model. `saturated`: JSON list of link directions (`<linkId>><from>`) at line rate. The diagram labels cables from `links`.

### `disk`

| Key | Type | Meaning |
|---|---|---|
| `state` | `online` \| `offline` \| `smart-check` \| `failed` | `failed`: kept offline, for example after 3 offline events in an hour. |
| `offlineEventsLastHour` | number | Times the disk went offline within Hades's recent window (`hci.diskOfflineWindowS`); at the profile's limit Hades keeps it offline. The inspector labels it "Recent offline events". |
| `media` | `nvme` \| `ssd` \| `hdd` | Schema value. |
| `capacityTiB` | number | Schema value. |
| `cvm` | string | The CVM whose Stargate uses this disk. |
| `replicas` | number | Healthy extent-group replicas stored on it. |

## `Snapshot.derived` (cluster-level)

All of these are scalars.

| Key | Type | Meaning |
|---|---|---|
| `haStatus` | `OK` \| `Healing` \| `Critical` | AHV HA status (AHV Admin Guide 11.2). |
| `zkQuorum` | boolean | The cluster (majority side) has ZK quorum. |
| `zkLeader` | string \| null | CVM id. |
| `acropolisLeader` | string \| null | **Host** id. |
| `resiliency` | `OK` \| `Rebuilding` \| `Critical` | Data resiliency, as in the Prism widget. |
| `nodeFailureTolerance` | number | **Additional** simultaneous node failures tolerated right now. In T1 this is the N−2 / N−3 rule minus the nodes already down. In HCI it is the FT achievable with the current replica state. |
| `ftConfigured` | number | Configured FT level: 1 or 2. In T2, RF3 means FT2. |
| `metadataAvailable` | boolean | Every Cassandra key range has a Paxos majority. |
| `dataAvailable` | boolean | Every extent group has at least one reachable replica. It is always `true` in T1, where the array owns the data. |
| `underReplicated` | number | Extent groups below their RF (0 in T1). |
| `clusterServices` | `up` \| `down` | Cluster services. `down` once ZK quorum or metadata has been missing for `cluster.zkSessionTimeoutS` (20 s); in T1 also when every node is in Hades maintenance. Only this field and Prism are delayed: `zkQuorum`, `metadataAvailable` and the `ClusterView` methods (`zkQuorum`, `inQuorum`, `isStargateUp`) change at once, so a backend's own detection delay (for example `hci.stargateDownDetectS`) is applied once, on top of an immediate signal. |
| `prismElement` | `up` \| `unreachable` | Prism Element follows `clusterServices` (SPEC §6.2). |
| `prismCentralAlert` | string \| null | `A200000` ("Cluster Connectivity Status", PC Alert Reference pc.7.6) while Prism Element is unreachable; `null` otherwise. |
| `faultToleranceByComponent` | JSON Record<`ZOOKEEPER` \| `METADATA` \| `EXTENT_GROUPS`, number \| null> | Data Resiliency widget rows: additional node failures each component tolerates now. `null` where the array owns it (T1 `METADATA`, `EXTENT_GROUPS`). |
| `blockAwareness` | `met` \| `not-met` \| `off` | Block fault-tolerance rule (Bible 4i). |
| `degradedNodes` | JSON string[] | CVMs Degraded Node Detection currently marks Degraded. |
| `zkMembers` | JSON string[] | CVMs holding a Zookeeper ensemble seat. |
| `engine.queuedActions` | number | Actions applied but not yet run: every action takes effect at the start of the next tick, and in manual mode several can wait (the inspector shows "Queued actions"). |
| `hci.rf` | number | HCI: the replication factor (2 or 3). |
| `hci.extentGroups` | number | HCI: extent groups the model tracks (a sample of the data, not the real count). |
| `hci.unavailableExtentGroups` | number | HCI: extent groups with no reachable replica (their IO hangs). |
| `hci.rebuildRemainingGiB` | number | HCI: GiB Curator still has to copy to restore RF. |
| `hci.dataNodeFailureTolerance` | number | HCI: node failures the data survives now: the fewest live replicas of any extent group, minus one, capped at the FT level. |
| `hci.capacityPct` | number | HCI: physical usage as % of the raw capacity of the disks in service. |
| `hci.resilientCapacityPct` | number | HCI: usage as % of resilient capacity (raw minus FT × the largest node, Bible 4i); Prism warns above `hci.capacityWarnPct`. |
| `hci.garbageReplicas` | number | HCI: stale replicas (extra copies after a node returned) the next Curator scan removes. |
| `hci.curatorLeader` | string | HCI: the CVM running the Curator leader (the first live one). |

## Event codes

`SimEvent.code` values the scenarios rely on, with the expected `deviceId`. The runner accumulates events across ticks. Golden lists are recorded as `"<t>\t<code>@<deviceId>"`, with debug-severity events excluded.

| Code | deviceId | When |
|---|---|---|
| `net.link.down` | link id | A link loses carrier. It must not fire for pure configuration events, such as a rebalance. |
| `net.bond.failover` | vswitch | vNICs or flows moved off a failed member. |
| `net.bond.rebalance` | vswitch | A balance-slb rebalance re-pinned a vNIC. |
| `net.bond.lacp-timeout` | vswitch | LACP timed out a member that had no carrier loss. |
| `net.bond.lacp-no-mlag` | vswitch | The members see different LACP partners (no MLAG). |
| `net.bond.lacp-fallback` / `net.bond.lacp-negotiated` | vswitch | A balance-tcp bond fell back to active-backup because no member is negotiated, or left that fallback. |
| `net.bond.mode-changed` | vswitch | The runtime bond mode changed. |
| `net.link.saturated` / `net.link.unsaturated` | link | T1 throughput model: one direction of the link reached line rate (its queue adds latency and the IO through it slows), or fell below it again. |
| `net.mtu.mismatch` | link or switch | A large frame was dropped for MTU. Emit it once per link, not per frame. |
| `switch.flow-control.unsupported` | switch | Flow control other than `off` is set (Everpure NET KB). |
| `nvme.path.lost` | cvm | One path was lost: its keep-alive expired, the target refused or reset the connection, or an IO timeout reset it. The text says which. |
| `nvme.io.timeout` | cvm | Commands on a live path got no completion in `ioTimeoutS`: retried elsewhere, and the path is reset. |
| `nvme.io.released` | cvm | After a silent loss, the target's TCP reset of the old connection released the held commands before the hold expired. |
| `nvme.path.inaccessible` | cvm | The path's controller reports ANA Inaccessible (it drains for a planned reboot): IO is retried on the other paths and none is sent on this one until it reconnects. |
| `nvme.path.restored` | cvm | A lost path reconnected. |
| `nvme.all-paths.lost` | cvm | That CVM has no live path left. |
| `fa.claim.expired` | the controller that saw it | The primary's drive-quorum claim expired. |
| `fa.promotion.start` / `fa.promotion.complete` | the promoting controller | |
| `fa.io-delay.timeout` | the stalled primary | The IO delay timeout fired. |
| `fa.giveback` | the controller giving up the primary role | |
| `fa.controller.draining` | controller | A planned reboot began: the controller answers new IO with ANA Inaccessible and finishes the IO in flight. |
| `fa.controller.rebooting` / `fa.controller.online` | controller | |
| `fa.ndu.start` / `fa.ndu.complete` | `fa` | |
| `mgmt.task.failed` / `mgmt.task.succeeded` | the VM (or object) the task was for | An array-management task finished. |
| `stargate.up` | cvm | Stargate became healthy, for example after the CVM booted. |
| `stargate.crashed` | cvm | The Stargate process exited on a running CVM (`cvm.crash-stargate`, or a hung one resumed and its watchdog fired); its self-monitor restarts it after `cluster.stargateSelfRestartS`. |
| `stargate.hung` | cvm | `cvm.hang-stargate`: the process stays alive but answers neither IO nor NOPs; its connections stay open. |
| `stargate.zk-session-lost` | cvm | A CVM cut off from its peers for the ZK session timeout: its Stargate dropped out (its sessions are reset and move elsewhere) until the network returns. |
| `stargate.vdisk.handover` / `stargate.vdisk.taken-over` | the CVM taking over | T1: a remote Stargate starts / completes taking over a vDisk whose owner CVM is in Hades maintenance (`vdiskHandoverS`, about immediate); its IO waits in between. |
| `redirector.unhealthy` | host | A silent Stargate: the initiators' NOPs to it went unanswered `missesToUnhealthy` times. A reset connection (stop, crash) is noticed at once and raises no `unhealthy`. |
| `redirector.redirect` | host | iSCSI sessions logged in (again) to another Stargate through the redirector. |
| `redirector.parked` | host | A session logged in to a peer that may not serve the vDisk yet: its leadership is still the silent Stargate's until that Stargate's ZK session expires. The initiator tries again at its next NOP cycle. |
| `redirector.leader-redirect` | host | A peer sent a session on to the vDisk's leader at its external portal; the leader is alive and answers, so it serves the session over the external network (no handover). |
| `redirector.path-internal` | host | A session that was on its local CVM's external portal moved back to the host-internal link after `externalPathValidityS`. |
| `cvm.planned-shutdown.start` / `cvm.planned-shutdown.off` | cvm | A planned shutdown began (token granted, traffic forwarded away, services stopping) / the CVM powered off after it. |
| `host.maintenance.enter` / `host.maintenance.exit` | host | The host entered / left AHV maintenance mode. |
| `vm.migrated` | vm | A live migration (host maintenance, or the return after it): IO paused for the switchover. |
| `vm.migrate-failed` | vm | No other host could take the VM when its host entered maintenance; it stays. |
| `redirector.failback` | host | One vDisk's session returned to the local Stargate (one per `failbackStepS`, after `failbackStableS`). |
| `ha.host.disconnected` | host | The text names alert A1006. |
| `ha.host.fenced` | host | |
| `ha.leader.elected` | the new leader host | Acropolis leader election. |
| `ha.vm.self-terminated` | vm | An isolated VM self-terminated, 45 s after its first failed IO. |
| `ha.vm.restarted` | vm | HA restarted it, on the host in `vm.host`. |
| `vm.io.guest-timeout` | vm | An IO stayed pending longer than the guest disk timeout. |
| `vm.force-shutdown` | vm | The per-VM path-loss force-shutdown fired. |
| `vm.crashed` | vm | The VM went down: with its host, or (`whole-array-loss-vm-behavior: crash-and-restart`) no Stargate served its disk for `redirector.initiatorSessionTimeoutS`, so the initiator gave up ("VM shut down unexpectedly"; for example a whole-array loss). |
| `cvm.network.blackout` | cvm | `cvm.network-flap`: its inter-CVM interface stops answering for a while. |
| `cvm.internal-link.down` / `cvm.internal-link.up` | cvm | The host-internal link between the AHV host and this CVM failed or returned. |
| `cvm.network.lossy` / `cvm.network.loss-cleared` | cvm | `cvm.network-loss` at or above `dnd.partialLossPct`: the CVM is half reachable; then its network is clean again. |
| `dnd.outlier` | cvm | `cvm.network-loss` below `dnd.partialLossPct`: peers score it as an outlier, nothing else changes. |
| `stargate.hung-op-fail-fast` | cvm | Its Stargate's operations on a half-reachable peer's metadata hung for `cluster.stargateHungOpS`, so it failed fast; it stays down until that peer is Degraded or reachable again. |
| `dnd.node.degraded` / `dnd.node.cleared` | cvm | Degraded Node Detection marked the node Degraded, or cleared it (auto-resolve or `cvm.mark-fixed`). |
| `cassandra.node.detached` | cvm | Auto ring-repair detached the node. |
| `curator.rebuild.start` | — or the CVM that lost data | |
| `disk.offline` | disk | |
| `cluster.services.down` / `cluster.services.up` | — | Quorum or metadata missing for the ZK session timeout (text names A3032 / A200000); back up. |
| `hades.maintenance.enter` | cvm | T1: the CVM lost its service volumes; Hades put the node in maintenance mode (alerts A3032, A1030). |
| `hades.maintenance.exit` | cvm | T1: a volume check found the service-volume mounts healthy again; the node leaves maintenance and its services restart (then `stargate.up`). |
| `zk.seat.migrated` | the CVM receiving the seat | T1: a lost active node's ZK/Cassandra service volumes were mounted here after `serviceVolumeMigrationDelayS`. |
| `zk.not-active` | the first seat that is not live | A ZK seat is down or off the quorum side (alert A111009). Raised only while a quorum side exists. |
| `cluster.cvm.unreachable` | cvm | A running CVM is outside the quorum side (alert A1001). |
| `ha.vm.restart-failed` | vm | HA wanted to restart it but no host can take it (alert A1145). |
| `ha.resources.insufficient` | — | Fewer than two hosts can run VMs (alert A130068). |
| `cluster.ft.insufficient-nodes` | — | The configured FT cannot be met with the CVM nodes that remain. |
| `cluster.advisory.co-ratio` | — | CO:HCI sizing advisory (community guidance, `unverified`). |

## Proposals (need the integrator)

### 1. Pass the accumulated context to expectations (`src/scenarios/define.ts`)

`Snapshot.events` only carries the last tick's events, so "did X happen, and when" needs run history. The change is backward compatible: existing `(s) => boolean` predicates still type-check.

```diff
-import type { ActionRequest, CitationId, SimTime, Snapshot } from '../engine/types';
+import type { ActionRequest, CitationId, SimEvent, SimTime, Snapshot } from '../engine/types';
+
+/** Run state accumulated by the runner (the snapshot carries only the last tick's events). */
+export interface ScenarioContext {
+  readonly now: SimTime;
+  /** Every event since t=0, oldest first, including this tick's. */
+  readonly events: readonly SimEvent[];
+  /** Every snapshot since t=0, oldest first; the last one is the current one. */
+  readonly history: readonly Snapshot[];
+}
+export type Predicate = (s: Snapshot, ctx: ScenarioContext) => boolean;

 export type Expectation =
-  | { readonly label: string; readonly at: SimTime; readonly that: (s: Snapshot) => boolean }
-  | { readonly label: string; readonly always: true; readonly that: (s: Snapshot) => boolean };
+  | { readonly label: string; readonly at: SimTime; readonly that: Predicate }
+  | { readonly label: string; readonly always: true; readonly that: Predicate };
```

Until this lands, `src/scenarios/context.ts` provides the bridge. `withCtx(fn)` wraps a context-aware predicate in a plain `(s) => boolean`, and the runner's `evaluate` passes it the context. After the change, `withCtx` becomes the identity and `ScenarioContext` can be re-exported from `define.ts`.

### 2. New action kinds

- `vm.snapshot` (target: vm) takes an array snapshot through the FA management API. T1-13 uses it.
- `vswitch.rebalance` (target: vswitch; params `vnic`, `member`) forces the next balance-slb rebalance to move one vNIC. Use it to put an interface on a chosen member deterministically (e.g. the swapped placement that sends all storage IO over the ISL).

### 3. New topology option

- `path-loss-force-shutdown-s` (T1 and T1-lab; number of seconds, absent means unset). It applies the schema's per-VM `pathLossForceShutdownS` to every VM. T1-lab-3 uses it. A per-VM runtime action would also work.
