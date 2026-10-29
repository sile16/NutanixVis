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
| `instances` | JSON string[] | Hosts with a live QEMU process for this VM. Normally 0 or 1. The "no VM runs twice" invariant checks that it has ≤ 1 entry. |
| `ioPendingS` | number | Age of its oldest outstanding IO (0 when nothing is outstanding). This measures the worst-case wait of a single command. |
| `readPendingS` | number | The same, for reads only. |
| `writePendingS` | number | The same, for writes only (for example, writes waiting on RF replication). |
| `ownerCvm` | string \| null | CVM whose Stargate serves its vDisks: the local CVM normally, a remote one after a redirect, and always remote on CO nodes. |
| `ioPaths` | JSON string[] | T1 only: NVMe path ids that carried this VM's vDisk IO during the last tick. |
| `ioUplinks` | JSON string[] | Physical NICs, on any host, that carried this VM's storage IO (iSCSI or NVMe/TCP) during the last tick. It is empty for HCI VMs served locally over `virbr0`. |
| `pathLossForceShutdownS` | number \| null | Optional. The per-VM force-shutdown timeout on storage path loss (T1); `null` means unset (retry forever). |

### `cvm`

| Key | Type | Meaning |
|---|---|---|
| `state` | `up` \| `down` | The CVM itself, powered on or not. |
| `stargate` | `up` \| `down` \| `unhealthy` \| `hung` | The Stargate process. `unhealthy`: running but failing (for example, ZK or metadata unavailable). `hung`: alive but answering neither IO nor NOPs (`cvm.hang-stargate`). |
| `nvmePathsUp` | number \| null | T1: count of `live` paths. `null` outside T1. |
| `nvmePathsTotal` | number \| null | T1: count of configured paths, live or not. |
| `nvmePaths` | JSON Record<pathId, `live` \| `lost` \| `removed`> | T1: per-path state. `lost`: keep-alive expired, the target reset the connection, or an IO timeout reset the path; reconnecting every `reconnectDelayS`. `removed`: the controller was deleted after `controllerLossTimeoutS`. |
| `nvmePathLatencyMs` | JSON Record<pathId, number \| null> | T1: latest IO completion latency seen on each path (network + array service, illustrative); `null` before any. The queue-depth selector weighs it (SPEC §6.4c "Slow link"). |
| `nvmePathIoShare` | JSON Record<pathId, number> | T1: share (%) of this CVM's IO commands sent on each path over the last 30 s. |
| `zkMember` | boolean | It holds a Zookeeper ensemble seat. |
| `zkQuorum` | boolean | It is in a partition that has a ZK majority. |
| `zkPartition` | string \| null | Stable id of its network partition (for example, the lowest CVM id reachable). The "unique quorum side" invariant groups by this. |
| `ringState` | `normal` \| `down` \| `detached` \| `forwarding` | Cassandra ring membership. `detached`: auto-removed after `cassandraRingDetachS`. `forwarding`: Degraded Node Detection disabled its metadata store (it holds no live replica). |
| `dndState` | `ok` \| `scoring` \| `degraded` | Degraded Node Detection (SPEC §6.2). `scoring`: its peers found it unresponsive and the `dnd.scoringWindowS` window is running. `degraded`: marked Degraded until `dnd.autoResolveHealthyS` of health or `cvm.mark-fixed`. |
| `hades` | `ok` \| `maintenance` \| `restarting` | T1 Hades state (SPEC §6.2). `maintenance`: every path to the CVM's service volumes was lost and the error lasted `hades.externalStorageErrorThresholdS`, so its services are stopped (`stargate` is `down`). `restarting`: a volume check found the mounts healthy again, the node left maintenance and the services are restarting (`hades.servicesRestartS`). Always `ok` outside T1, or with `hades-maintenance-on-storage-error: off`. |

### `cvm-interface` (schema fields, echoed into the view)

| Key | Type | Meaning |
|---|---|---|
| `service` | `mgmt` \| `external-storage` \| `backplane` | Used to count a CVM's storage vNICs. |
| `vlan` | number | |

### `ahv-host`

| Key | Type | Meaning |
|---|---|---|
| `power` | `on` \| `off` | |
| `role` | `hci` \| `compute-only` \| `storage-only` \| `external-storage-compute` | Schema role. |
| `haState` | `connected` \| `disconnected` \| `fenced` | The Acropolis leader's view of the host. `disconnected`: heartbeats are missing. `fenced`: Stargates block its IO, from T+60. It returns to `connected` once the host rejoins. |
| badges | — | The `acropolis-leader` badge appears on the leader host. |

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

### `nic` (host NICs and FA ports)

| Key | Type | Meaning |
|---|---|---|
| `link` | `up` \| `down` | Carrier. |
| `speedGbps` | number | |

### `switch`

| Key | Type | Meaning |
|---|---|---|
| `state` | `up` \| `failed` \| `hung` | `hung`: stops forwarding but keeps carrier on every port (`switch.hang`). |
| `vlans` | string | Comma-separated VLANs carried. |
| `flowControl` | `off` \| `global-pause` \| `pfc` | |

### `fa-array`

| Key | Type | Meaning |
|---|---|---|
| `ioServing` | boolean | `false` during an array-wide IO pause. |
| `pauseS` | number | How long the current array-wide pause has lasted (0 while serving). |
| `primary` | string \| null | Controller id holding the primary role; `null` while none does, for example mid-promotion. |
| `mgmtApi` | `up` \| `unreachable` | Management API (`fa.vir0`) reachability from the cluster. |

### `fa-controller`

| Key | Type | Meaning |
|---|---|---|
| `role` | `primary` \| `secondary` \| `promoting` \| `offline` | |
| `state` | `up` \| `crashed` \| `rebooting` \| `stalled` | `stalled`: alive but not completing IO (`fa.io-stall`). |

### `fa-interface`

| Key | Type | Meaning |
|---|---|---|
| `nic` | string | The port it lives on (schema). |
| `vlan` | number | Schema value. |
| `service` | `nvme-tcp` \| `mgmt` \| `replication` | Schema value. |
| `enabled` | boolean | Admin state (`fa.interface.disable` / `enable`). |
| `oper` | `up` \| `down` | `down` if disabled, if its port has no carrier, or if its controller is not `up`. |

### `disk`

| Key | Type | Meaning |
|---|---|---|
| `state` | `online` \| `offline` \| `smart-check` \| `failed` | `failed`: kept offline, for example after 3 offline events in an hour. |
| `offlineEventsLastHour` | number | |

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
| `net.bond.vlan-stranded` | vswitch | A vNIC's VLAN is carried by no surviving member (VLAN-aware MAC pinning under isolated VLANs), so it is left unpinned and its traffic is dropped until a member returns (`assumption`, SPEC §6.5). |
| `net.bond.mode-changed` | vswitch | The runtime bond mode changed. |
| `net.mtu.mismatch` | link or switch | A large frame was dropped for MTU. Emit it once per link, not per frame. |
| `switch.flow-control.unsupported` | switch | Flow control other than `off` is set (Everpure NET KB). |
| `nvme.path.lost` | cvm | One path was lost: its keep-alive expired, the target refused or reset the connection, or an IO timeout reset it. The text says which. |
| `nvme.io.timeout` | cvm | Commands on a live path got no completion in `ioTimeoutS`: retried elsewhere, and the path is reset. |
| `nvme.io.released` | cvm | After a silent loss, the target's TCP reset of the old connection released the held commands before the hold expired. |
| `nvme.path.restored` | cvm | A lost path reconnected. |
| `nvme.all-paths.lost` | cvm | That CVM has no live path left. |
| `fa.claim.expired` | the controller that saw it | The primary's drive-quorum claim expired. |
| `fa.promotion.start` / `fa.promotion.complete` | the promoting controller | |
| `fa.io-delay.timeout` | the stalled primary | The IO delay timeout fired. |
| `fa.giveback` | the controller giving up the primary role | |
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
- `vswitch.rebalance` (target: vswitch; params `vnic`, `member`) forces the next balance-slb rebalance to move one vNIC. T1-16 uses it to show a rebalance stranding a vNIC under isolated A/B VLANs, deterministically.

### 3. New topology option

- `path-loss-force-shutdown-s` (T1 and T1-lab; number of seconds, absent means unset). It applies the schema's per-VM `pathLossForceShutdownS` to every VM. T1-lab-3 uses it. A per-VM runtime action would also work.
