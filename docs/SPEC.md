# NutanixVis — Project Specification

Status: **draft v0.2 (2026-10-27)**. This spec comes before any code. Decisions marked **[DECIDED]** are the defaults to build on. Items marked **[OPEN]** need the owner's answer and are collected in §12.

Owner decisions (2026-10-27):

- **AHV only.** ESXi is out of scope.
- **Public from day one.** The repo and Pages site are public.
- **"Everpure" branding.**
- **React + React Flow.**
- **Current release only.** Model only the most current release behavior, with no historical behavior or explanations. Use a version selector so future behaviors can be added (§2.1).

Supporting research:

- `docs/research/tooling.md` covers the framework and library evaluation, with versions checked on 2026-10-27.
- `docs/research/nutanix-hci.md` covers HCI failure behavior, the timer table and its sources.
- `docs/research/nutanix-flasharray.md` covers the Nutanix + FlashArray integration, FlashArray HA behavior, the timer table and its sources.
- `docs/internal/` is git-ignored. It holds notes from internal Everpure sources that must not be published.

---

## 1. Product goal

The app is a browser-based, interactive failure simulator. The user picks a topology, optionally misconfigures it, injects failures, advances simulated time, and watches what the real products would do. Behavior is driven by state machines that model the vendors' documented mechanisms. Every timer and rule carries a citation.

### 1.1 Topologies in scope

| # | Topology | Phase | Notes |
|---|---|---|---|
| T1 | **Nutanix compute-only cluster (AHV) + external Everpure FlashArray over NVMe/TCP** | v1 | This is the only supported shape of the integration. It is **AHV-only and NVMe/TCP-only**. The CVMs still run Stargate, which uses an SPDK NVMe/TCP initiator, and cluster metadata (Cassandra/Zookeeper/Curator) lives on per-node FA volumes. Each vDisk maps to exactly one FA volume, with no separate change-tracking volume. |
| T2 | **Nutanix HCI on AHV** | v1 | CVM + local disks, RF2/RF3, Autopath via the iSCSI redirector, AHV HA. |
| T3 | **Nutanix HCI with dedicated compute-only (CO) and storage-only (SO) nodes** | v1 | CO nodes run VMs with no CVM, and their storage IO goes over the network to CVMs on HCI or SO nodes. SO nodes run only a CVM and never run VMs. There are two variants: **CO + SO** (fully disaggregated) and **CO + HCI** (mixed). |
| T1-lab | **T1 mirror of the test drive lab**: a single NIC per node with no uplink bond | v1 | The same domain model as T1. Used to compare simulator output against lab measurements (`docs/research/lab-validation-plan.md`). |
| — | 2-node HCI + Witness | later | |
| — | FA ActiveDR / async with Nutanix | later | ActiveCluster is not supported on Nutanix volumes in the current release. |
| — | Metro Availability / SyncRep | out of scope for v1 | |
| — | ESXi (any topology) | **out of scope** | This is an owner decision. |

### 1.2 Target audience and non-goals

- **Audience:** SEs, architects, support, and customers learning failure domains.
- **Non-goals:** this is not a performance model or a sizing tool, and it does not emulate real CLIs. Latencies are illustrative and relative, not benchmarks.

---

## 2. Accuracy policy [DECIDED]

1. **Cited rules.** Every modeled rule, timer and threshold lives in a version profile (§2.1) as a named constant with a `cite` field pointing into `src/domain/citations.ts`.
2. **Public sources only.** The repo and site are public. Each citation is `{id, title, url, publisher, retrieved}` and must point to a **publicly reachable** source: Nutanix Bible, portal docs and KBs, support.everpuredata.com, or vendor blogs.
   - Facts known only from internal Everpure material (`docs/internal/`, git-ignored) must not appear in code, comments, docs or UI.
   - Where only internal data exists, the model uses a value labeled `assumption`, chosen independently of the internal figure, and lists it under "Gaps" until a public source exists.
3. **Confidence labels.** Each rule is tagged with one of:
   - `verified`: a primary vendor doc or KB
   - `inferred`: derived from documented mechanisms
   - `unverified`: a community post or third-party blog
   - `assumption`: no public source
   - `lab-observed`: measured on our test drive instance, recorded with the AOS, AHV and Purity//FA versions and the date (see `docs/research/lab-validation-plan.md`)

   The UI shows the label next to explanations, so users can see where the model is a best guess.
4. **Current release only.** The app models the behavior of the newest release in the version matrix (§2.1). It contains **no historical behavior and no "in older versions…" explanations**. When a newer release changes behavior, add a new profile; older profiles may be deleted rather than maintained.
5. **Unverified timers.** Where the vendor publishes no number (for example, how long AHV I/O pauses during a CVM redirect), use a documented assumption, label it, and list it in `docs/research/*` under "Gaps".

### 2.1 Version selector [DECIDED]

**How the selector works**

- The header has a **two-level version selector**:
  1. **Nutanix version**: the AOS release, together with its paired AHV and Prism Central versions.
  2. **FlashArray version**: Purity//FA. This list shows only the versions supported with the selected Nutanix version, and appears only for T1.
- **Defaults.** Both selectors default to the most recent entries.
- **Changing the Nutanix version** re-filters the FlashArray list. If the current FlashArray selection is no longer supported, it resets to the newest supported version.

**How versions drive behavior**

- **Version matrix.** `src/domain/versions/matrix.ts` holds declarative data. It lists the Nutanix releases (newest first), and for each one the supported Purity//FA versions and a `profileId`. Every entry carries a citation to the public compatibility doc (REQ / RN in `docs/research/nutanix-flasharray.md`).
- **Behavior profiles.** `src/domain/versions/profiles/*.ts` holds one object per profile. It contains every timer, threshold and feature flag the domain modules read, for example `vdiskVolumeMapping: '1:1'`, the NVMe timers, the AHV HA timeline and the FT thresholds.
- **Selecting a profile.** The active profile comes from the selected (Nutanix, FlashArray) pair. If a pair needs its own behavior, the matrix entry can override the `profileId`.
- **No version checks in domain code.** Domain modules never branch on version strings; they read only the active profile. Adding future behavior means adding a profile plus matrix rows, with no engine changes.
- **Launch content.** v1 ships with **one profile, for the current release**. The matrix lists the current AOS release and its supported Purity//FA versions.
  - The research has AOS 7.6 / AHV 11 as current, with Purity//FA 6.11.8+ / 6.12.x supported.
  - Re-check REQ and RN when scaffolding.
- **Where the version appears.** The selected versions are part of the share-link URL state and the scenario definition. Scenarios may pin a version, and by default they use the newest.

---

## 3. Tech stack [DECIDED unless noted]

Details and alternatives are in `docs/research/tooling.md`. Versions were checked against npm on 2026-10-27.

| Area | Choice |
|---|---|
| Language | **TypeScript 7.0** (native `tsc`), with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax` |
| Runtime / package manager | Node 24 LTS, **pnpm 12** |
| Build / dev server | **Vite 8** (`base: '/NutanixVis/'` for Pages) |
| UI | **React 19** |
| Diagram | **React Flow (@xyflow/react 12)** for nodes and edges, plus our own **Canvas2D packet overlay** |
| Panels and styling | **Tailwind CSS 4 + shadcn/ui** (Radix); brand tokens as CSS variables |
| Engine→UI bridge | Engine publishes frozen per-tick snapshots; React reads them with `useSyncExternalStore`. **Zustand 5** is used only for UI state (selection, speed, panels). |
| Schemas | **Zod 4** for topology and scenario validation (types via `z.infer`) |
| Tests | **Vitest 5** (unit + scenario), **fast-check 4** (property/invariant), **Playwright** (e2e smoke + visual snapshots) |
| Lint / format | **Biome 2** (lint + format), `tsc --noEmit` in CI |
| CI / hosting | GitHub Actions → GitHub Pages (static, no backend) |

**Why React Flow + an overlay rather than Cytoscape:**

- Ports become React Flow *handles*. Each cable then has distinct endpoints, which matches real cabling (CT0.eth10 → Switch A port 3) and avoids most parallel-edge bundling.
- Nodes are React components, which makes branded device cards easy.
- Edge geometry comes from our own pure `geometry.ts`. That module feeds both the SVG edge and the packet overlay through `pointAt(t)`, so nothing touches library internals (compare `edge._private.rscratch` in the reference).
- The fallback, if compound auto-sizing becomes painful, is Cytoscape.js 3.34 with the same overlay pattern, using only its public `sourceEndpoint/controlPoints/midpoint` APIs.

**Known gotchas:**

- TS 7 has no programmatic API until 7.1. typescript-eslint and svelte-check don't support it yet, which is one reason we use Biome rather than ESLint.
- React Flow parent nodes don't auto-fit their children, so the layout module computes group bounds.
- Never use `animated: true` edges; draw packets on the canvas instead.

---

## 4. Repository layout

The project is a single package, with a module boundary enforced by tests and lint. It can be split into a pnpm workspace later if needed.

```
src/
  engine/            # generic, vendor-agnostic, no DOM, no React
    clock.ts         # sim time, tick, timers (named, cited, in seconds)
    device.ts        # Device tree: id, parent, children, lifecycle hooks
    network/         # Port, Link, Switch(VLAN-aware L2), Bond, Endpoint(IP on VLAN), routing/reachability
    messaging.ts     # send/deliver rounds, packet traces for animation
    events.ts        # typed event log (cause ids, cite ids, severity)
    actions.ts       # action registry: which device kinds accept which actions
    snapshot.ts      # frozen, versioned snapshot builder
    rng.ts           # seeded RNG (determinism)
    sim.ts           # Simulation: load(topology) → applyAction → tick → snapshot
  domain/
    citations.ts     # citation registry (public sources only)
    versions/        # matrix.ts (Nutanix → supported Purity//FA, profileId) + profiles/ (timers, thresholds, flags)
    nutanix/         # CVM, Stargate, Zookeeper ensemble, Cassandra ring, Curator, Acropolis/AHV HA,
                     #   iSCSI redirector, OVS bond config, cluster FT/resiliency
    flasharray/      # Array, Controller (primary/secondary HA), FE ports, NVMe subsystem/ANA, pod/volumes, mgmt API
    nvme-tcp/        # host-side initiator: controller per path, KATO, reconnect, ctrl-loss
    workload/        # VM / vDisk IO generator, VM lifecycle (running/paused/hung/crashed/restarting)
  topologies/        # declarative data (.ts objects validated by Zod): devices, links, VLANs, layout, options
  scenarios/         # scenario definitions (setup + timeline + expectations + narrative)
  ui/
    app/             # shell, routing (hash), brand theme
    diagram/         # React Flow node/edge components, geometry.ts, PacketOverlay (canvas)
    panels/          # actions, time controls, event log, inspector, explain, scenario picker
    store/           # zustand UI store, engine bridge hook
tests/
  engine/            # unit tests for primitives
  domain/            # unit tests per state machine
  scenarios.test.ts  # auto-generates one test per scenario file
  invariants.test.ts # fast-check properties
  e2e/               # Playwright
docs/
```

**Boundary rule.** `engine/` imports nothing from `domain/`, `ui/` or `topologies/`. `domain/` imports only `engine/`. `ui/` may read engine types and snapshots but must never mutate engine state except through `sim.applyAction` and `sim.tick`. This is enforced by Biome `noRestrictedImports` plus an architecture test that scans imports.

---

## 5. Simulation engine

### 5.1 Time model [DECIDED]

The reference project used abstract steps. Here the vendor timers are concrete (AHV HA T+20/60/120 s, FA IO delay timeout 15 s, Cassandra detach 30 min), so the engine uses a **simulated clock**:

- **1 tick = 1 simulated second.** This is fixed and configurable per topology only if a scenario needs finer resolution; FA claim expiry is about 1 s.
- **Timers are declared in seconds** (named and cited) and counted in ticks. The UI shows `T+mm:ss` since the scenario started.
- **Controls:**
  - **Step**: one tick.
  - **Auto-step**: play at ×1, ×5, ×20 or ×60 real time.
  - **Manual mode**: queue several actions without time advancing, as in the reference's "auto-step off".
  - **Fast-forward to next timer**: the engine knows the soonest pending timer, which covers waits like the 30-minute Cassandra ring detach.
- **Determinism.** The same topology, actions and seed always produce the same event log. Devices iterate in sorted-id order, there's a seeded RNG, and nothing reads the wall clock.

### 5.2 Tick phases

Each tick runs these phases from the root in order:

1. **Apply queued actions** (fail or recover a device or link, set an option).
2. **preTick.** Devices read the *previous* snapshot's view of the world and decide what to emit.
3. **Emit.** Devices send messages (heartbeats, NOPs, IO, KATO keep-alives, ZK pings, HA polls).
4. **Deliver.** Up to *N* delivery rounds run (default 3: request → response → follow-up). Messages sent in round *k* are delivered in round *k+1*, so a request/response RTT fits in one tick. Delivery uses the L2 network (§5.3), and each message produces a **trace** (link ids traversed, plus where it was dropped and why).
5. **tick.** State machines update from what was or wasn't received: miss counters and timers fire.
6. **postTick.** Aggregate and derived state is computed: cluster quorum, FT status, VM IO state, resiliency.
7. **Snapshot.** A frozen snapshot is built, with `version++`, and events are appended.

This keeps the reference's key property that all devices see a consistent snapshot, and it makes "missed N heartbeats in M seconds" rules map directly onto ticks.

### 5.3 Network model

- **Port, Link, Switch.** Links have `up/down`, `latencyMs` (illustrative) and `mtu`. Ports have admin and oper state. Failing a device takes its ports down.
- **VLAN-aware L2.** Switch ports are `access(vlan)` or `trunk(vlans[])`, and an ISL is just a trunk link. Delivery is computed by BFS over up links in the frame's VLAN, which replaces the reference's flooding with no MAC learning. The result is the same, but it is deterministic and cheaper.
- **Endpoint.** An IP interface on a VLAN, owned by a device (CVM storage vNIC, FA ct0.eth10, FA mgmt, Prism VIP). Messages go endpoint-to-endpoint.
- **Flows.** Every message carries a flow identity: `{srcMac, vlan, srcIp, dstIp, srcPort, dstPort}`. Bonds pick a member link by that identity, so how paths spread over uplinks falls out of the model rather than being scripted.
- **Bond (AHV OVS virtual switch).** Modes follow AHV Admin Guide 11.2 Table 9. Each mode decides which member link each flow egresses on:

  | Mode (Prism name) | OVS mode | Member selection | Switch requirement | Max per-vNIC bandwidth |
  |---|---|---|---|---|
  | Active-Backup | `active-backup` | All flows use the single active member | None | 1 link |
  | Active-Active with MAC pinning | `balance-slb` | Per **source MAC + VLAN**: each vNIC is pinned to one member. Hash buckets are periodically **rebalanced** by load; the OVS default interval is 10 s, and whether Nutanix overrides it is an `assumption`. | Plain trunk ports. **No LAG/LACP.** | 1 link |
  | Active-Active | `balance-tcp` + LACP | Per **L4 flow**: each TCP connection is hashed to a member | LAG + LACP. Across two switches this needs **MLAG/vPC**. Fast rate (1 s) by default, with fallback to active-backup. | All links |
  | No uplink bond | — | 0 or 1 uplink | None | 1 link |

- **Active-backup member.** OVS makes "the first member to be enabled" active (OVS bonding docs), which is eth0 → Switch A on every host. It can be pinned with `ovs-appctl bond/set-active-slave` (Everpure "Configure Nutanix Cluster for FlashArray"). Topology option `vs0-active-member` (T1, T2, T3): `first` (default, OVS behavior) or `alternate` (odd hosts on Switch A, even hosts on Switch B). The pinned member is preferred whenever the bond picks a new active member; there is no failback to it. The view field `activeMember` shows the current one.
- **Failure detection in bonds:**
  - **Carrier loss** (NIC, cable or switch port down) is detected immediately in every mode (`bond_downdelay` 0).
  - **Failures without carrier loss** (a hung switch, a unidirectional link) are only detected by LACP: within about 3 s on the fast rate, or up to 90 s on slow (AHV Admin Guide). LACP liveness is LACPDU receipt only (OVS `lib/lacp.c`), so a switch whose data plane hangs while it keeps sending LACPDUs is never detected.
  - **Active-backup, MAC pinning and no-bond never detect a hang.** They watch carrier only, and AHV adds no run-time check that moves the active member. The blackhole lasts until the hang becomes carrier loss (the switch is powered off or its ports are admin-downed); OVS then fails over in the same tick.
  - **LACP rate.** Prism Active-Active always sets fast with fallback to active-backup, and neither can be changed afterwards (AHV Admin Guide 11.2). A slow host rate exists only when set outside Prism (CLI or installer). A slow switch-side rate alone still leaves the host detecting in 3 s (`inferred`).
  - **`lacp-fallback-ab`** (profile `bond.lacpFallbackAb`). A member whose LACP times out is detached while another is still negotiated, so the LAG carries on with the survivor. Only when no member is negotiated does the bond run active-backup over every member with carrier (`lacpState: fallback`).
  - On failover, the vNICs or flows on the dead member move to a survivor, and the switches relearn the MACs (OVS sends a RARP per moved MAC).
  - **MAC-pinning rebalance** follows OVS: a hash moves only off a member that carries at least 2 hashes with traffic, at least 3 % more load than the lighter member, and only if the move narrows the gap. The 1 Mbps floor is not modeled (loads are message counts).
  - **Misplacement.** If the VLAN a vNIC uses is not carried on the surviving member's switch, its traffic blackholes. The bond is not VLAN-aware.
- **MTU mismatch.** Messages are tagged with a size class (`small` for heartbeats and keep-alives, `large` for 1 MiB IO). Large frames are dropped on links whose MTU is lower than the endpoint MTU, so the "small IO works, large IO stalls" misconfiguration can be shown.
- **Latency.** Latency accumulates along the path into IO latency reported by VMs. It is illustrative and never drives timing; the NVMe queue-depth selector weighs it when it spreads IO (§6.4c "Slow link").
- **Grey failure (`link.set-loss`).** A link keeps carrier and forwards, but each frame crossing it is lost with the given per-packet probability. A `large` frame stands for a multi-packet data transfer (`largeFrameSegments`, model granularity), so data is hit far more often than single-packet keep-alives. The draw is a deterministic hash of the link and a per-link frame counter (drop reason `loss`).
- **Flap (`link.flap`).** Carrier drops now and returns after the given time, applied at the start of that tick before any traffic.

### 5.4 Messages and traces

```ts
type Message = { id; kind: MsgKind; src: EndpointId; dst: EndpointId; size: 'small'|'large'; payload; causeId? }
type Trace   = { msgId; kind; links: LinkId[]; result: 'delivered'|'dropped'; dropAt?: LinkId|DeviceId; reason? }
```

`MsgKind` is an open string union, and domain modules register their kinds along with a display color and category. The initial categories are:

- `io-read` and `io-write`
- `replication` (Oplog RF writes)
- `nvme-io` and `nvme-keepalive`
- `iscsi-nop`
- `zk`, `cassandra`, `ha-poll` and `mgmt`

### 5.5 Devices and actions

- **Device.** A device is `{id, kind, label, parent, children, state}`. It implements `preTick/emit/onMessage/tick/postTick`, and each hook has a no-op default.
- **Actions.** Actions are registered per device kind with an `appliesTo(device)` predicate. The UI only offers applicable actions, an improvement on the reference, which ignored irrelevant ones silently. The common actions are:
  - `fail`, `recover`, `power-off` and `reboot`
  - `link-down` / `link-up`, and `set-latency`
  - kind-specific ones: `fa.controller.failover` (planned), `fa.ndu`, `fa.io-stall`, `fa.interface.disable` / `enable` (one FA data IP), `cvm.stop-stargate`, `host.isolate`, `disk.fail`, `switch.fail`, `switch.port.prune-vlan`
  - timed and grey-failure injections: `link.flap {durationS}` and `fa.interface.flap {durationS}` (the FA port behind one IP loses link, then returns), `link.set-loss {pct}`, `set-latency {ms}`, `cvm.network-flap {durationS}` (the CVM's inter-CVM interface stops answering, then returns), and the operator action `cvm.mark-fixed` (clear a Degraded node, §6.2)
- **Runtime network-configuration actions.** These can be changed **mid-scenario**, so users can compare bond setups on the same running workload:
  - `vswitch.set-bond-mode` sets Active-Backup, MAC pinning, LACP or no-bond. It applies to every host on that virtual switch, because Nutanix does not support mixed bond modes (AHV Admin Guide).
  - `vswitch.set-uplinks` adds or removes NICs from the bond.
  - `vswitch.set-lacp-rate` sets fast or slow.
  - `fabric.set-mlag` turns MLAG on or off.
  - `fabric.set-vlan-placement` switches between tagged on both switches and strict A/B.
- **How the changes apply.** They take effect at the next tick. The real procedure is noted in the Explain panel. For example, enabling Active-Active (LACP) in Prism performs a rolling host reboot, and a Quick-method uplink update that takes over 30 s triggers HA (AHV Admin Guide). Simulating the rolling procedure itself is a later option.
- **Build-up and misconfiguration actions.** These are topology options exposed as actions:
  - single storage VLAN
  - strict A/B fabrics vs trunked + ISL
  - MTU mismatch
  - LACP slow
  - HA reservation off
  - RF2 vs RF3
  - block awareness met / not met

### 5.6 Snapshot and event log

- **Snapshot.** `{version, simTime, devices: Record<id, DeviceView>, links: Record<id, LinkView>, traces: Trace[], derived: {...cluster status}}` is plain frozen data. Each device kind defines its `DeviceView`, which holds what the inspector shows.
- **Event.** An event is `{t, id, severity, deviceId, code, text, causeIds[], cite[]}`. Events form a causal chain: "Switch A failed → CVM-2 lost paths ct0.eth10/ct1.eth10 → after the keep-alive timeout, those NVMe controllers are marked lost → IO continues on fabric B". The Explain panel renders the chain with citations.

---

## 6. Domain models (v1)

Each model is a state machine plugged into the engine primitives. Timers and rules come from the research tables. The **inline numbers below are summaries**; the authoritative values and sources are the research docs and `citations.ts`.

### 6.1 Workload (shared)

- **VM.** States are `running | io-stalled | paused | crashed | restarting | off`.
  - A running VM emits read and write IO every tick to its vDisk owner, which is the local Stargate when healthy.
  - IO latency is shown, and IO that is pending for longer than the guest timeout produces an event.
  - `io-stalled` means IO is pending but the VM is still running.
  - **Queue depth.** Each vDisk keeps at most `queueDepth` IOs outstanding (32, illustrative). The T1 option `guest-queue-depth` (32, 8, 4, 1) models a queue-depth-bound guest with few slots, which a silent path loss can stall completely (§6.4c item 3).
  - **Whole-array loss (T1).** With `whole-array-loss-vm-behavior: crash-and-restart` (default), a VM whose oldest IO has waited `guest.ioStallCrashS` while no CVM reaches the array crashes ("VM shut down unexpectedly": QEMU exits), and AHV HA restarts it once the array and the cluster services are back (§6.4).
- **vDisk.** Each vDisk has an owner Stargate. Ownership moves on a CVM redirect, or after 300 s or more of remote IO (Bible 4a).

### 6.2 Nutanix cluster (shared by T1 and T2)

**Zookeeper ensemble**

- 3 members, or 5 under FT2 (KB-1587: "RF2 has 3 zookeeper servers … RF3 has 5", `verified`). There is one leader.
- Quorum is a majority of members that can reach each other.
- Losing ZK quorum stops the cluster on that side. IO effects are immediate. "Cluster services down" and Prism Element loss follow one ZK session timeout later (`cluster.zkSessionTimeoutS` = 20 s). The value is `inferred` from public CVM logs ("negotiated timeout=20 secs") and the Genesis flag `--zk_initial_connection_wait_secs` ("Shorter than session timeout", Command Reference 7.6).
- **Seats.**
  - HCI (T2/T3): fixed on the lowest-id CVM nodes in block-aware order.
  - T1: a seat holder is an "active node" that mounts the ZK/Cassandra service volumes. A seat is live only while its CVM reaches those volumes on the array.
  - T1: a lost seat moves to an inactive array-connected CVM only after `cluster.serviceVolumeMigrationDelayS` = 300 s, and never during an upgrade. Source: NCP with Dell PowerStore Deployment Guide 7.6, "after a 5-minute delay"; the FlashArray guide omits the sentence, so `inferred`.
  - T1: the seat moves to the partition that keeps at least N − tolerance array-connected CVMs (the N−2 / N−3 rule). Until then, losing two of three seats loses quorum.
- **No quorum anywhere (total partition).**
  - HCI: a VM whose IO fails self-terminates `isolatedVmSelfTerminateS` (45 s) after its first failed IO, as on an isolated host. Bible 5b ties the rule to IO failure, not to a majority existing.
  - HCI: when quorum re-forms, the new Acropolis leader restarts the VMs that were running (`ahvHa.selfTerminateWithoutQuorum`, `inferred`; the restart is anecdotal, from a public r/nutanix thread).
  - T1: VMs stall and retry until storage responds (§14 #1).

**Cassandra ring**

- Metadata RF3 under FT1 and RF5 under FT2.
- The ring is modeled as K token ranges (default 12) with replicas on ring neighbors, which are block- or rack-aware when enabled.
- A key range is available only if it has a Paxos majority.
- A node that has been down for 30 minutes is detached from the ring (Bible 4i, KB-1256), and it rejoins after it has been stable.

**Stargate**

- Stargate runs per CVM.
- In T2 it serves IO from the extent store. In T1 it serves IO through its NVMe/TCP initiator to FA volumes (§6.4).
- It goes unhealthy if its CVM is down, if ZK or metadata is unavailable, or (in T1) if all its NVMe paths are lost (**[OPEN-6]**).
- Outside the quorum side it still answers NOPs and refuses writes. In HCI it refuses reads too, because resolving an extent needs a Cassandra lookup and no key range has a Paxos majority there (`inferred`, Bible 4g/4i). In T1 it still serves reads.

**Hades service volumes (T1)**

- On external storage the ZK, Cassandra and Curator data live on per-CVM service volumes on the array (Bible 8c). The CVM reaches them through its kernel NVMe/TCP initiator with Linux native multipathing (Everpure "Nutanix Cloud Infrastructure Configuration"), managed by Hades.
- AOS 7.6 Hades flags (Command Reference 7.6, `verified` text):
  - The mounts are checked every `hades.volumeMonitorIntervalS` = 5 s.
  - An external-storage error that lasts `hades.externalStorageErrorThresholdS` = 5 s is "critical" and puts "the node in maintenance mode".
  - All NVMf volumes are re-mapped every `hades.mapNvmfVolumesIntervalS` = 300 s.
- **Model (`inferred`).**
  - The kernel path uses the same storage vNICs and FA ports as Stargate's initiator, so "no live NVMe path" stands in for "service volumes unreachable".
  - **When.** The kernel initiator queues IO while it waits for a path (controller loss 3600 s), so the mount check fails only once its IO is abandoned at the NVMe IO timeout (`externalStorage.ioTimeoutS`). Maintenance therefore follows path-loss detection (KATO), that timeout, the next monitor check and the 5 s threshold: about a minute after a silent loss, after the silently lost path's own IO has been abandoned.
  - **Admission (`assumption`).** Maintenance takes the node out of the cluster, so it is admitted only while the nodes already out (down or in maintenance) stay within the N−2 / N−3 tolerance. A refused node (`hades.maintenance.refused`) keeps its Stargate up, its IO retries in place, and Hades retries at every check. On a whole-array loss every node tries, but only N−2 get in.
  - In maintenance the CVM's services stop (Stargate, ZK member, Cassandra, Acropolis), exactly as for a CVM that is down. The redirector moves the host's VM sessions to a Stargate that reaches the array, and seats and leaders move.
  - **vDisk handover (`externalStorage.vdiskHandoverS`, `assumption`).** The remote Stargate must take each vDisk over from the CVM in maintenance (ownership and NVMe reservation, Bible 8c) before it serves its IO. The guest sees the redirect within seconds, but its IO resumes only after the handover: clearly longer than the redirect, shorter than an AHV HA restart.
  - The initiator keeps reconnecting meanwhile. The first re-map that finds the array restarts the services (`cluster.cvmBootS` settling), and the sessions then fail back.
- **Lab switch.** The topology option `hades-maintenance-on-storage-error` (default `on`, the profile's `hades.maintenanceOnStorageError`) turns this off for lab L1. With it off, a CVM without paths keeps its Stargate up and IO retries in place (DEPLOY-GUIDE default).

**Acropolis / AHV HA**

- There is one Acropolis leader, which polls the libvirt on each host at 1 Hz.
- Timeline for a lost host:
  - **T+20:** the 40 s timeout starts, and a new leader is elected if the leader's host was lost.
  - **T+60:** Stargates fence IO from that host.
  - **T+120:** the host's VMs are restarted on hosts with capacity (Bible 5b; AHV Admin Guide).
- An isolated host's VMs self-terminate 45 s after their first failed IO. The model asserts that no VM ever runs twice.
- HA reservation is `best-effort` or `guarantee` (N+1 for FT1, N+2 for FT2).
- **What HA watches.** AHV HA reacts to the Acropolis leader losing a host's management services (its libvirt heartbeat). The leader polls its own host over the internal `virbr0` bridge, so a host whose management IP is unreachable but whose CVM is the leader still answers and does not trigger HA. Other hosts are polled on their management IP (Bible 5b; AHV Admin Guide "Fault Detection for High Availability").

**Degraded Node Detection** (Nutanix community "Degraded Node Detection"; Command Reference 7.6 lists a `disable-degraded-node-monitoring` command; profile `dnd.*`)

- DND is on by default. Peers score each CVM's responsiveness. A running CVM that its peers cannot reach (outside the quorum side, for example during a network flap or a partial blackout) starts a scoring window of `dnd.scoringWindowS` (`assumption`).
- If the CVM answers again by the end of the window, it is marked **Degraded** (`dnd.node.degraded`): its Cassandra goes to **forwarding mode** (metadata store disabled, `ringState: forwarding`), so it holds no live metadata replica, the cluster's node-failure tolerance drops, and an alert is raised. A CVM still cut off or down at the end is not a degraded-node case; isolation and HA handle it.
- While a node is Degraded, a second CVM outage can leave metadata key ranges without a Paxos majority, so cluster storage goes down although only one CVM is down (T2-13).
- It is cleared only after a long healthy observation period (`dnd.autoResolveHealthyS`, `assumption`) or when an operator marks it fixed (`cvm.mark-fixed`).

**Cluster status (derived)**

- Covers ZK quorum, metadata availability, FT level achievable vs configured, resiliency status (OK, Rebuilding or Critical), and leaders (ZK, Acropolis, Curator, Prism).
- **Prism.** Prism Element is a cluster service with an elected leader, so it is `unreachable` once services are down. Prism Central, a separate VM, then shows A200000 "Cluster Connectivity Status" (PC Alert Reference pc.7.6). Prism Element's own alerts are cluster services too, so none are raised without quorum.
- **Alert IDs in events** (PE Alerts Reference 7.0, PC Alert Reference pc.7.6):
  - A3032 "Cluster services are down" and A1030 "Stargate Temporarily Down": Hades maintenance, Stargate stop.
  - A1001 "CVM Connectivity Failure": a running CVM outside the quorum side.
  - A1006 "Host IP Not Reachable": host disconnected.
  - A111009 "Zookeeper Not Active on All CVMs": a seat is not live.
  - A1145 "Failure To Restart VMs For HA Event" and A130068 "Insufficient Resources for VM High Availability".
- **Data Resiliency rows** (`ncli cluster get-domain-fault-tolerance-status`, AHV Admin Guide 11.2): node-failure tolerance for ZOOKEEPER, METADATA and EXTENT_GROUPS (`faultToleranceByComponent`).

### 6.3 HCI data path (T2 only)

**Extent groups**

- Each vDisk is abstracted to E extent groups (default 8). Real extent groups are 4 MiB, or 1 MiB with deduplication (Bible 4g), so a real vDisk has thousands; E is model granularity only.
- Replica placement is deterministic: RF2 or RF3, with one replica local when written and the rest on other nodes, block- or rack-aware when enabled.

**Writes**

- A write goes to the local Oplog and is synchronously replicated to RF−1 remote CVMs before it is acknowledged (Bible 4g). Replication packets are shown on the diagram.
- With the local CVM down, all replicas are written remotely.

**Stargate-down detection** (KB "IO freeze in UVMs is expected when CVM on different node shutdown or Stargate on different node crashes", cited by title, `inferred`)

- A peer Stargate that goes **silent** (node power loss, hang, hard CVM power-off, or network isolation, i.e. outside the ZK quorum side) is declared down when its Zookeeper session expires: `hci.stargateDownDetectS` = 20 s.
- A **cleanly stopped** Stargate closes its session and is declared down in `hci.stargateStopDetectS` = 1 s.
- Until the declaration, writing Stargates still target the silent node's replicas, so writes that need one **stall**. Then the replica is re-placed on another node. This is the visible IO freeze of up to about 20 s.
- A replica write to a peer that is still up but dropped the frame or did not ack is re-placed after `hci.replicaAckTimeoutS` (2 s, `assumption`). A disk that Stargate marks offline is skipped at once.
- Once declared down, the node's replicas stop counting as live copies and the rebuild clock starts. The model approximates a CVM reboot command as a silent loss (the cluster view cannot tell it from a power-off).

**Autopath on AHV**

- The iSCSI redirector sends a NOP to the local Stargate about every 1 s. The interval is not published; the cadence is inferred from the Bible's redirector log sample.
- Two or more misses in 30 s mark it unhealthy, and the session moves to a healthy remote Stargate. This is the hypervisor-agnostic Autopath rule from 2014; the AHV count is not published (`assumption`).
- Failback happens only after the local Stargate has been stable for `redirector.failbackStableS` = 300 s ("once the local stargate is back online (and stable for 300 seconds)", Josh Odgers 2015, `unverified`). Failback is much slower than the failover. The Genesis `--def_stargate_stable_interval` (30 s) is a different path: when Genesis treats a Stargate as healthy, not the redirector's failback.
- A session with no target (every Stargate was failing) logs in afresh to the first Stargate that answers again, preferring the local one; the failback hold only applies to moving a working session.
- The duration of the IO pause while the initiator (Frodo/QEMU) re-logs in is an `assumption` (`redirectStallS`, 3 s).

**Curator rebuild**

- Rebuild starts `hci.rebuildStartDelayS` = **60 s** after a Stargate is declared down, or after Stargate marks a disk offline (`inferred`). Bible 4i's "immediately" means there is no long repair-delay timer; the KBs "Delayed rebuild for planned maintenance events" and "Slow data rebuild after failure on clusters with Erasure Coding enabled" (cited by title) give the 60 s selective-scan trigger. For a node power loss the rebuild therefore starts about 80 s after the failure.
- It runs at `hci.rebuildGiBpsPerNode` = 0.5 GiB/s per surviving node (`assumption`), spread across the N survivors, so each node does about 1/N. Josh Odgers' public 2018 tests work out to about 0.3–0.6 GB/s per surviving node, and an all-flash node rebuild is "expected 1 to 2 hours" (KB above). With the defaults, a 4-node T2 cluster at 20 % fill re-protects one node in about 64 min, so the 30 min ring detach happens mid-rebuild.
- The resiliency status shows Rebuilding from the failure (including the wait for the start) until all extent groups are back to RF.
- Curator partial scans run about every hour and full scans about every 6 h (`inferred`: Nutanix-staff community posts, KB-2101 by number). Extra copies left by a returning node are removed at the next partial scan.
- Ring rejoin: a detached node is re-added after it has been stable for `cluster.cassandraRejoinStableS` = 30 min (KB-1256, `inferred`).

**Disks**

- A disk fails into offline. When the fault clears, Hades runs a `smartctl` short self-test (`hci.diskSmartCheckS` = 120 s, `assumption`: a short test takes a minute or two, smartctl(8)) and returns the disk if it passes. If the disk goes offline 3 times in an hour, it stays offline.
- Stargate goes read-only at 95% capacity. A capacity slider in later versions is optional.

**Data outcomes beyond FT**

- An extent group whose replicas are all on down nodes or disks makes the owning vDisk's IO hang. Metadata ranges without quorum do the same.
- The cluster-wide effect is labeled `unverified` (see `nutanix-hci.md` "Gaps").

### 6.3a Compute-only and storage-only nodes (T3)

**Compute-only (CO) nodes** (AHV Admin Guide 11.2 "AHV Compute-Only Node Configuration"):

- **No local CVM or storage.** A CO node has no CVM and no local storage for VMs. Its VMs "use CVMs running on the HCI nodes to access disks" (`verified`).
- **IO path.** The CO host's iSCSI redirector has **no local Stargate**, so every login is redirected to a Stargate on an HCI or SO node over the physical network (`inferred` from the AHV storage overview).
  - **Stargate selection.** Nutanix describes it only as "heuristics-based" (community, `unverified`). The model assumes the vDisk's owning Stargate is spread round-robin across the CVM nodes, as an `assumption`.
  - **Consequence: the bond carries storage IO.** On a CO node, the bond and the uplinks are in the **storage IO path**. On HCI nodes, VM→CVM traffic stays inside the host on `virbr0`. A NIC, bond or switch failure on a CO node therefore hits VM IO directly, which is a key teaching point.
- **No data locality.** All RF replicas of a CO VM's writes are remote.
- **HA.** CO nodes take part in AHV HA as restart targets and sources (community, `unverified` for details). Two or more CO nodes are needed for CO-to-CO restarts.

**Storage-only (SO) nodes** (AHV Admin Guide "Adding an AHV Storage-Only Node"):

- **No VMs.** AOS never schedules VMs on an SO node, so it is never an HA restart target.
- **Large CVM.** The CVM gets most of the host's resources: all cores minus 2, and RAM minus 16 GiB, capped at 256 GiB.
- **Cluster size.** The cluster must have at least 3 functioning nodes at all times, and at least 3 schedulable nodes before the first SO node is added.

**Cluster services in T3**

- Zookeeper, Cassandra, Stargate and Curator run only on **CVM-bearing nodes** (HCI and SO). Quorum, RF placement, FT and rebuild are counted over those nodes only.
- An SO node failure follows the T2 timing (§6.3): writes needing its replicas stall until its Stargate is declared down (about 20 s), and Curator starts the rebuild 60 s later. A CO node holds no data, so its failure starts no rebuild.
- CO nodes count toward HA compute capacity only.

**Sizing guidance** (community 2019, `unverified`): a 2 HC : 1 CO ratio, and starting with 4 HCI nodes. The model shows this as an advisory warning, not a hard rule.

### 6.4 FlashArray + NVMe/TCP (T1)

**Array**

- The array has 2 controllers, one primary and one secondary.
- Both controllers' FE ports serve IO. The secondary forwards IO to the primary.
- The primary holds the drive-quorum claim (Purity HA KBs).

**Failover rules**

| Event | Behavior |
|---|---|
| Primary crash | The secondary sees the claim expire in about 1 s, then promotes. The array-wide IO pause lasts a few seconds up to about 16 s; the model uses a tunable default. |
| Primary IO stall | After the IO delay timeout of 15 s, a giveback, then promotion. |
| Planned failover / NDU | Pause ≤15 s. An NDU reboots the secondary first and then the primary. A rebooting controller's ports disappear, because there is no NPIV for Ethernet or NVMe. |
| Secondary crash | No array-wide pause. Only IO in flight on the secondary's paths retries elsewhere. |
| Design objective | Total failover ≤30 s. |

**NVMe ANA**

- On a physical FA, **every path is ANA Optimized** on both controllers. Primary-optimized / secondary-non-optimized is a cloud-only behavior and is not modeled for physical arrays.

**Host initiator (SPDK, in the CVM)**

- There is one NVMe controller per path: 2 VLANs × 2 controllers gives 4 paths per CVM.
- If keep-alive (KATO) is missed, the path is marked lost.
- Reconnect attempts repeat until the controller-loss timeout expires, then the controller is removed.
- The integration sets KATO (5 s), CQT (30 s) and the controller-loss timeout (3600 s) automatically (Everpure "Nutanix Cloud Infrastructure Configuration", public; AOS 7.6 Command Reference Hades gflags). The reconnect delay and IO timeout are not published: the profile labels them `assumption` and `inferred` (§6.4c).
  - Public generic guidance (TCP-BP, Everpure DM-multipath settings) can inform the model but must not be presented as the integration's values.
- The multipath policy is an `assumption` (active-active across live Optimized paths). The path selector is `inferred`: **queue-depth** by default, round-robin as an option (§6.4b, §6.4c).

**Objects**

- **Hierarchy:** a realm, one pod per cluster, **exactly one FA volume per vDisk** (no separate change-tracking volume), and per-node service volumes for Cassandra, Curator and Zookeeper (BIBLE-ARCH).
- **Inspector-only:** in v1 these objects appear in the inspector and are not simulated individually.

**Management**

- The FA mgmt API is a separate endpoint. If it is unreachable or slow, provisioning and snapshot actions fail, but running IO is unaffected.

**T1 compute cluster HA** (DEPLOY-GUIDE "Compute Cluster High Availability", `verified`)

- **Availability domain.** VM data sits in the array's own availability domain, so surviving compute capacity bounds VM availability, not an in-cluster FT level.
- **Simultaneous node-failure tolerance.**
  - Fewer than 5 nodes: up to **N−2** nodes. For example, 3 nodes tolerate 1 failure and 4 nodes tolerate 2.
  - 5 or more nodes: up to **N−3** nodes.
- **Service recovery.** After a multi-node failure, cluster services resume automatically on the surviving nodes, because their data is on dedicated array volumes.
- **Per-VM path-loss handling.**
  - By default, a node **retries IO until the array responds**, so VMs stall rather than fail.
  - An optional per-VM **force-shutdown timeout** restarts affected VMs on a node that still has array connectivity. This is a per-VM option in the inspector.
- **Sizing limits.** At least 3 nodes (1- and 2-node clusters are unsupported), and at most 10,000 vDisks per cluster.

**T1 full array loss**

- All cluster-service volumes are on the FA, so ZK quorum, cluster services and Prism Element go down and there is no HA. Every node tries to enter Hades maintenance mode, but only N−2 (N−3) are admitted (§6.2); the rest keep trying with their Stargate up.
- VM IO stalls everywhere. What the VMs then do is the topology option `whole-array-loss-vm-behavior` (`assumption`, default from `externalStorage.wholeArrayLossVmBehavior`):
  - `crash-and-restart` (default): a guest cannot wait forever. Once a VM's IO has stalled `guest.ioStallCrashS` (minutes) it crashes (QEMU exits, "VM shut down unexpectedly"). Nothing restarts it while the array is gone; after the array returns and the services re-form, AHV HA restarts the VMs on hosts whose CVM reaches the array (T1-26).
  - `stall`: the DEPLOY-GUIDE wording taken literally: VM IO retries until the array responds, and the VMs resume in place.
- An outage shorter than `guest.ioStallCrashS` only stalls the VMs under either option (T1-10).
- **Recovery** (`inferred`): paths reconnect. Seats lost for `serviceVolumeMigrationDelayS` move to array-connected CVMs, so quorum and the services can re-form before the nodes in maintenance return; those restart at their next periodic re-map (`hades.mapNvmfVolumesIntervalS` after maintenance began, then `cluster.cvmBootS`).
- How long Stargate tolerates hung operations before it restarts is not public (**[OPEN] Stargate hung-op threshold**).

### 6.4b Path usage: how one vDisk's IO spreads (T1)

This model drives both the IO distribution and the **path-usage view** in the UI.

**Layers, top to bottom**

1. **vDisk → CVM.** Each vDisk is locked to exactly one Stargate, normally the CVM on the VM's host, and that Stargate holds the NVMe Persistent Reservation (BIBLE-ARCH). A vDisk's IO therefore only ever leaves through **that one node's** `vs1` uplinks. IO is spread across nodes by VM placement, not by multipathing.
2. **CVM storage vNICs.** Each storage segment (internal interface with External Storage enabled, one VLAN) gives each CVM **one vNIC and one IP** (DEPLOY-GUIDE "Creating an Internal Interface"). With the recommended ≥2 storage VLANs (NET), each CVM has ≥2 storage vNICs, each with its own MAC.
3. **NVMe paths.** One NVMe controller connects each CVM storage vNIC to each FA target port on the same VLAN. In the default topology that is 2 vNICs × 2 FA ports per VLAN = **4 paths per CVM**, all ANA Optimized.
   - **Connections per path.** Each path is several TCP connections: 1 admin queue + Q IO queues, as defined by the NVMe/TCP spec. Q is an `assumption`, default 4.
4. **Multipath policy** (Stargate/SPDK). The policy Nutanix configures **is not public**. SPDK supports both of these, so the simulator offers both as a profile option with the `assumption` label until lab L12 settles it:
   - `active-active` (default): each vDisk's IO spreads across all live Optimized paths. The **path selector** (topology option `nvme-path-selector`, profile `pathSelector`) picks the path per command:
     - `queue-depth` (default, `inferred` from Everpure's Linux guidance for FlashArray NVMe: dm-multipath `queue-length`, TCP-BP "Queue Length Based"): the live path with the fewest outstanding commands.
     - `round-robin`: the next live path in turn.
   - `active-passive`: one active path per vDisk, with vDisks spread across paths and failover on path loss.
   - The two selectors look the same in steady state. They differ on a silent path loss (§6.4c item 3).
5. **Bond.** The bond maps each path's TCP connections onto uplinks (§5.3).

**Can one vDisk use both uplinks?**

| `vs1` bond | Multipath active-active | Multipath active-passive |
|---|---|---|
| Active-Backup | **No.** Every path is on the single active uplink. | No |
| MAC pinning (balance-slb) | **Yes, but split by vNIC.** The VLAN-A vNIC is pinned to one uplink and the VLAN-B vNIC usually to the other. Pinning is by hash, so both can land on the same uplink until a rebalance. | **No** for one vDisk, whose single path is on one uplink. Many vDisks spread across both uplinks. |
| LACP (balance-tcp) | **Yes.** Each path's TCP connections are hashed across both uplinks. | **Partly.** A single path's IO-queue connections can still hash to both uplinks. |

**Failover interplay** (see §6.4a):

- **Bond-level failures** (a node NIC, cable or switch port) are absorbed by the bond when the VLAN exists on the surviving switch. No NVMe path is lost.
- **Multipath-level failures** (FA ports, FA controller, a switch or the FA-side links) remove paths. The policy then redistributes IO over the paths that remain.

**UI: path-usage view**

- Selecting a VM or vDisk highlights its owning CVM, its active NVMe paths, and the uplink each path's connections use, with per-uplink and per-FA-port share bars.
- A node-level toggle shows **bond member utilization** and the vNIC → uplink pinning, which updates live on rebalance and failover.

### 6.4c NVMe/TCP path-failure timing (T1)

The integration sets the multipath and NVMe timers automatically, and they must not be changed (Everpure guidance). The model uses the profile fields `keepAliveTimeoutS` (KATO), `commandQuiesceTimeS` (CQT), `lostPathHoldKatoMultiplier`, `controllerLossTimeoutS`, `reconnectDelayS` and `ioTimeoutS`. Their semantics follow the NVMe Base Specification 2.1 (§3.9.3.1.2 Keep Alive; §9.6 communication loss handling, which includes CQT from TP4129):

1. **Keep-alive.** The host sends Keep Alive on each path's admin queue every KATO/2. The target (the FA controller) also tears down an association that goes quiet for KATO.
2. **Detecting a lost path.** The initiator runs **inside the CVM**, whose vNIC never sees a host uplink, cable or switch lose carrier.
   - **Silent losses, the normal case:** a node NIC, cable or switch failure, an FA port failure, an FA controller crash, a pruned VLAN, or a strict-A/B frame with no member carrying its VLAN. In each case, keep-alive goes unanswered and the path is lost **KATO after the last successful exchange**. (The spec allows detection anywhere up to 1.5 × KATO; the model uses KATO.) Keep-alive is traffic-based, the mode the hold below assumes: a completed IO command counts as an exchange, so a path that still completes IO is not declared lost when a keep-alive goes astray.
   - **Fast losses, the exception:** if the far end is reachable and actively closes the connection, the path is lost on that error before KATO. Examples are a TCP reset, a disabled FA interface, or a graceful controller reboot during NDU (`inferred`).
3. **IO around a path loss.**
   - **During the detection window** the initiator cannot tell the path is dead, so **new IO still goes to it** according to the path selector; nothing is redistributed until the path is declared lost.
     - `queue-depth`: each of the dead path's IO queues (`ioQueuesPerPath`) is idle, at depth 0, just like the live ones, so a guest that re-issues each completed IO at once lands a command on every dead queue within moments; after that the dead queues are deeper than the live ones and get no more. **The rule:** a queue-depth-bound guest whose queue depth is at most the number of IO queues the dead path holds has every slot stuck: it **stalls completely** until the stuck commands are abandoned (the hold below), then IO resumes on the surviving paths with no guest error (T1-22, `guest-queue-depth: 4`). A deeper queue keeps most of its slots: a **partial stall** (lower effective queue depth plus latency outliers).
     - `round-robin`: every Nth new command goes to the dead path, so **all** of a closed-loop guest's slots end up there whatever its queue depth: a complete stall until the hold expires.
     - (`assumption`: the model's few IOs per tick stand for that sub-millisecond closed loop. A path counts as dead for it only while it completes no IO at all, so a lossy path is not a sink.)
   - **After the loss is declared,** new IO uses the remaining live paths. All paths are ANA Optimized, so with `active-active` the load just redistributes.
   - **Commands in flight on a silently lost path** are retried on another path only at **`lostPathHoldKatoMultiplier` × KATO + CQT after the path's last successful exchange**. NVMe 2.1 §9.6.2 asks the host to wait until the controller must have detected the loss (2 × KATT with command-based keep-alive, 3 × KATT with traffic-based), then CQT, so the target can quiesce them and no stale or duplicate write lands. The multiplier is 3, an `assumption` (the conservative traffic-based case; the array's mode is not published). The spec lets reads retry at detection; the model holds all IO.
   - **On a closed connection** (fast loss) the keep-alive wait does not apply (§9.6.2 step 2c): new IO moves to the other paths at once and commands in flight wait **CQT**.
   - So the worst case for a single command is about **3 × KATO + CQT ≈ 45 s** after a silent loss, and CQT after a closed connection. With `queue-depth` the VM sees outliers on a fraction of its IO; with `round-robin` a queue-depth-bound guest sees a hard pause of that length. A guest only sees errors if the wait exceeds its disk timeout (Linux SCSI timeout 60 s, AHV Admin Guide).
   - **IO timeout.** A command stuck on a live but broken queue (a hung bond member, a lossy link, no carrier loss) is aborted after `ioTimeoutS` and retried on another path, and the host **resets the path** (error recovery: it tears the association down and reconnects after `reconnectDelayS`). It must be at least the hold above, or a command could be retried while still in flight: 45 s (`inferred`, the same §9.6 derivation applied to the published timers).
   - **TCP retransmission.** A frame the network dropped silently is resent with a doubling timer (RFC 6298 §5.5): 1, 1, 1, 2, 4, … s up to `tcpRtoMaxS` (the sub-second first retries fold into 1 s ticks). Keep-alives are resent every second.
   - **Target reset.** The target tears an association down when it goes quiet for KATO, or at once when the FA port it lives on loses link (`assumption`). A later frame of that association is answered with a TCP reset. After a silent loss the host keeps retransmitting the oldest held command on the old connection, and probes it again right after a reconnect; a reset proves the target holds none of the held commands, so they are retried after `targetResetRetryS` (0) instead of waiting out the hold (`nvme.io.released`).
4. **Reconnect.** A lost path retries every `reconnectDelayS`. When it reconnects, the path is restored (Optimized) and IO rebalances onto it.
   - **Short port flap (T1-23).** If the FA port returns before the stuck IO is abandoned, the target resets the stale connections, so the stuck IO is retried at once: the guest stall is about the outage length (plus the reconnect delay when the outage outlasted KATO), not the 45 s hold. The initiator then runs a normal reconnect cycle.
   - **Lossy link (T1-24, grey failure).** No path is declared failed: keep-alives are single packets and get through, and completed IO counts as keep-alive. IO on the lossy path is resent with backoff, so it sees multi-second latency outliers and short stalls, and its outstanding commands steer the queue-depth selector away. Eventually a command waits past the IO timeout: it is retried on the healthy fabric and the path is reset and reconnects. Once the loss is removed the path is used like the others.
   - **Slow link (T1-25).** Added latency on one path: its IO completes later by the added latency (once per crossing). A slower path drains its queue more slowly, so under `queue-depth` it holds more commands and gets proportionally less new IO (Little's law: it is eligible about every (its latency ÷ the fastest path's latency)-th turn), but it keeps being used. `round-robin` ignores latency and keeps an equal share.
5. **Controller loss.** If a path has not reconnected within `controllerLossTimeoutS`, its controller is deleted, and the path stays gone until it is rediscovered.
   - The timeout is set long enough to ride out long FA controller reboots, such as an NDU with a firmware update.
6. **All paths lost** (the CVM, its fabric or the array):
   - IO is **queued and retried** while any path is still inside its controller-loss window. This matches "a node retries IO until the external storage array responds" (DEPLOY-GUIDE).
   - The per-VM force-shutdown timeout, if set, restarts the VM on a node that still has connectivity.
   - Once every path's controller is deleted, queued IO fails to the guest.
7. **Bond interplay.**
   - When a bond failover keeps the VLAN reachable, the TCP connections survive and NVMe never notices.
   - When it doesn't (strict A/B), the path is lost through keep-alive (item 2), and step 3 applies.

**Values.** **KATO 5 s, controller loss 3600 s, CQT 30 s** are set automatically and must not be changed (Everpure "Nutanix Cloud Infrastructure Configuration", public, `everpure-nutanix-nci-cfg`; Hades gflag `--nvme_ctrl_loss_tmo` in the AOS 7.6 Command Reference, `ntnx-cmdref-aos-7.6`; also `everpure-nutanix-301-deck`, published with the owner's approval). A single command's worst case on a silent path loss is therefore about 3 × 5 + 30 = 45 s, under the 60 s guest timeout. The IO timeout is 45 s (`inferred`); the reconnect delay is 10 s (`assumption`, the Linux `NVMF_DEF_RECONNECT_DELAY` default); the hold multiplier and the multipath policy are `assumption`s and the path selector is `inferred`. The generic 10 s multipath retry of HA-Scenarios (`flasharray.hostMultipathRetryS`) is SCSI / dm-multipath `fast_io_fail_tmo` behavior and does not apply to this path.

**Flexibility rule.** Every timer and policy is a profile field and every behavior choice is a topology option. Real path-failover testing on a properly multipathed lab may change any of them; that is a data change, not a code change.

### 6.4a Failure-mode matrix (what fails, what detects it, what happens)

This is the reference that E, F, G and H implement. Each row is about **one** failure layer.

**T2: HCI on AHV**

| Failure | Detector and timer | IO effect | VM / HA effect | Data effect |
|---|---|---|---|---|
| **Stargate process down** (CVM up) | iSCSI redirector NOP to the local Stargate, about 1 s; ≥2 misses in 30 s mark it unhealthy (`inferred`) | The QEMU iSCSI re-login is redirected to a healthy remote Stargate (AHV Admin Guide "Storage Overview"). There is a brief stall whose length is an `assumption`. Latency rises. | None | Rebuild starts 60 s after the Stargate is declared down (clean stop: about 1 s), §6.3 |
| **CVM down** (host up) | Same as above, plus loss of the CVM's ZK and Cassandra membership | Redirected to a remote CVM (AHV Admin Guide). Failback only after 300 s stable, much slower than the failover. | None, and the VM keeps running (AHV Admin Guide) | Writes needing its replicas stall until it is declared down (about 20 s); rebuild starts 60 s later (§6.3). The node is detached from the Cassandra ring after 30 min. Leaders it held are re-elected. |
| **Host / node down** | Acropolis leader heartbeat at 1 Hz; HA fault detection also covers host management-service heartbeats and a corrupt or read-only root FS (AHV Admin Guide) | — | T+20 the 40 s timeout starts; T+60 fence; T+120 restart, subject to resources. HA status goes OK → Healing → Critical/OK. | As for CVM down |
| **Host network isolation** | As for host down, from the majority side | The local Stargate cannot complete RF writes and is in the ZK minority, so writes fail. Reads fail too, because there is no metadata majority (`inferred`). | Isolated VMs self-terminate 45 s after their first failed IO, then restart on the majority side by T+120 | The majority declares its Stargate down at ZK session expiry (about 20 s); rebuild starts 60 s later (§6.3) |
| **One uplink or ToR down** | Bond: active-backup on link state; LACP fast ≤3 s / slow ≤90 s | Hashes on the dead member blackhole until detection (LACP only) | None if a member survives | None |
| **Disk down** | Stargate IO error, then a Hades SMART check; 3 offline events in 1 h keeps the disk offline | None (re-read from a replica) | None | Rebuild starts 60 s after the disk goes offline |
| **Failures beyond FT** | — | IO to unreachable extents or metadata hangs (`unverified` cluster-wide effect) | Guests time out (Linux SCSI timeout 60 s, AHV Admin Guide) | Data unavailable, not lost, until a replica returns |
| **vSwitch quick update over 30 s** | — | — | HA is triggered (AHV Admin Guide) | — |
| **Total partition** (no partition has ZK quorum, e.g. both ToRs down) | — | Every Stargate is outside quorum, so reads and writes fail. Services and Prism Element are down after the ZK session timeout (20 s). | No fence and no HA while no quorum exists. VMs self-terminate 45 s after their first failed IO (`inferred`, Bible 5b). When quorum re-forms, the new leader restarts them (anecdotal). | No rebuild without quorum |

**T1: AHV + FlashArray**

The VM → redirector → Stargate leg behaves as in T2. The differences come from the Stargate → array leg.

| Failure | Detector and timer | IO effect | VM / HA effect | Data effect |
|---|---|---|---|---|
| **One node storage NIC or cable down** (`vs1` member) | **Bond first.** MAC pinning fails over on link state. LACP detects in ≤3 s (fast) or ≤90 s (slow). | **Strict A/B (default):** that NIC's VLAN has no other member, so its paths go silent and are lost after **KATO** (§6.4c). New IO then continues on the other VLAN's paths. In-flight commands on the lost paths retry at 3 × KATO + CQT ≈ 45 s after the last exchange (§6.4c). **Tagged on both switches with storage VLANs allowed on the ISL:** the vNIC moves to the surviving uplink and **no NVMe path is lost** (`inferred`). If the ISL is pruned (the default), the paths are lost as in strict A/B. | None | None |
| **One NVMe path down** (FA port, FA-side cable, a pruned VLAN, or an unrecoverable node-side path) | Initiator keep-alive: lost KATO (5 s) after the last exchange; at once if the target closes the connection | Until detection the selector still sends new IO to it (§6.4c item 3). **Queue-depth (default):** a few commands stuck, retried at 3 × KATO + CQT ≈ 45 s; IO continues on the other paths. **Round-robin:** a queue-depth-bound guest stalls completely for ≈ 45 s. The generic 10 s multipath retry (HA-Scenarios) is SCSI / dm-multipath behavior, not this path. | None (stall < guest timeout) | None (no RF; the array owns the data) |
| **One storage switch down** | Keep-alive (KATO); the CVM never sees the carrier loss | Every path through that switch is lost after KATO: in strict A/B, all of one VLAN's paths. New IO then moves to the other fabric. In-flight commands retry at 3 × KATO + CQT, so the worst case is about 45 s (§6.4c); with round-robin the guest pauses for that long. | None (stall < guest timeout) | None |
| **FA primary controller down** | Secondary sees claim expiry in about 1 s, then promotes | Array-wide pause from a few seconds up to about 16 s. The controller's ports disappear. | None, if the pause is under the guest timeout | None |
| **FA secondary controller down** | Keep-alive (KATO): a crash is silent | Only IO on its paths stalls, then retries on the primary's paths at 3 × KATO + CQT (§6.4c). A graceful reboot (NDU) closes the connections instead: its paths are lost at once and in-flight IO waits CQT. | None | None |
| **FA IO stall on primary** | IO delay timeout of 15 s, then giveback | Pause of 15 s plus promotion | None | None |
| **Stargate or CVM down** (host up) | Redirector NOP (as in T2) | Redirected to a remote Stargate, which takes the vDisk lock and NVMe Persistent Reservation (Bible ext-storage) | None | None (no rebuild) |
| **One CVM loses all array paths** | Its service volumes are gone too. The volume check's IO is abandoned at the NVMe IO timeout; Hades checks every 5 s, marks the error critical after 5 s and puts the node in maintenance mode (Command Ref 7.6). Its Stargate stops, then the redirector NOP rule applies. | IO pauses for KATO, the IO timeout, up to 10 s more and the redirect; the remote Stargate then takes the vDisks over (`vdiskHandoverS`, `assumption`) before IO runs there (`inferred`). After the paths return, the next 300 s re-map restarts the services (`cvmBootS`) and sessions fail back after 300 s stable. | None. The VMs keep running on their host. The Acropolis leader and the ZK seat move off the node (the seat after 300 s). | None |
| **One CVM loses all array paths, Hades maintenance off** (lab option) | Stargate still answers NOPs, so **the redirector has no reason to move** (`inferred`) | **IO retries until the array responds** (DEPLOY-GUIDE) | Optional **per-VM force-shutdown timeout** restarts the VM on a node with connectivity (DEPLOY-GUIDE). Otherwise the VM stalls. | None |
| **Host / node down** | As in T2 | — | AHV HA as in T2. The cluster tolerates N−2 (<5 nodes) or N−3 (≥5) simultaneous node failures, and services resume automatically (DEPLOY-GUIDE). If the lost nodes held a ZK majority of seats, services resume only once the seats move (300 s). The new leader then runs the HA timeline from its own election. | None |
| **Whole array or both fabrics down** | Every node tries Hades maintenance mode; only N−2 (N−3) are admitted, the rest keep trying | All IO stalls (DEPLOY-GUIDE: it retries). Cluster services and Prism Element stop, because their volumes are on the array. After the array returns, paths reconnect, seats migrate or the next 300 s re-map restarts the services (`cvmBootS`). | `whole-array-loss-vm-behavior`: `crash-and-restart` (default, `assumption`): VMs crash after `guest.ioStallCrashS` of stalled IO and AHV HA restarts them after the array returns; `stall`: VMs stall and resume in place. Per-VM force-shutdown only helps if some node still has connectivity. | None |
| **FA port flap** (link down, then up) | The target drops the port's connections (`assumption`); hosts see silence, then a TCP reset | Stuck IO is retried as soon as the port returns (the reset), so the stall is about the outage; then a normal reconnect | None | None |
| **Lossy link** (grey failure) | Nothing declares it: keep-alive and completed IO keep the path live | Multi-second outliers on that path; eventually an IO timeout retries the command elsewhere and resets the path; used again once the loss is gone | None | None |
| **Slow link** (added latency) | Nothing declares it | Queue-depth shifts share to faster paths but keeps using it; its IO is slower by the added latency | None | None |
| **FA mgmt API down or slow** | — | Running IO is unaffected | Provisioning, snapshot and DR tasks fail | None |

**Known gaps.** These are `assumption` values in the profile until a public source exists:

- The length of the redirect stall.
- The integration's NVMe reconnect delay, IO timeout, path selector and keep-alive mode (command- or traffic-based), and whether reads skip the in-flight hold. KATO, CQT and controller loss are published.
- The default per-VM force-shutdown timeout.
- How long a guest survives a whole-array IO stall (`guest.ioStallCrashS`), the vDisk handover time (`vdiskHandoverS`), maintenance admission, and the target's connection reset on port link loss.

### 6.5 Default reference topologies

**T1 default: AHV + FlashArray**

- **4 AHV nodes**, which tolerate 2 simultaneous node failures (N−2, DEPLOY-GUIDE). A 5-node variant shows the N−3 regime.
- Each node has two virtual switches, each with 2 NICs (DEPLOY-GUIDE Table 2):
  - `vs0` carries mgmt, live migration, DR and application traffic, in Active/Backup.
  - `vs1` carries NVMe/TCP data only, and its NICs are always bonded.
- **`vs1` bond mode** (see `docs/research/nutanix-flasharray.md` §2a):
  - **Default: Active/Active with MAC pinning.** This is Everpure's recommendation (NET), it is acceptable to Nutanix, and it needs no MLAG.
  - **Option: LACP**, which Nutanix prefers when available (DEPLOY-GUIDE). It needs MLAG/vPC across the two switches and has fast/slow detection timers.
  - **Option: no-bond.** Both vendors discourage it, and it is shown as a misconfiguration.
- On `vs1`, one NIC goes to Switch A and one to Switch B.
- **Two isolated storage VLANs** (default, the typical storage design): VLAN A only on Switch A, VLAN B only on Switch B. NET lists "dedicated switches for each VLAN" as a supported design. Ports are tagged trunks that allow only the required VLANs.
- **Switch settings:** STP enabled with node and array ports as edge ports. **Flow control off.** NET: "Do not enable Priority Flow Control (PFC) or Global Pause … not supported by Everpure FlashArray in NVMe/TCP environments". A `flow-control` option (global-pause | pfc) is a misconfiguration to demo.
- The FA has ct0.eth10 and ct1.eth10 on Switch A, and ct0.eth11 and ct1.eth11 on Switch B, plus FA mgmt.
- **Options:**
  - **Bond mode** for `vs1`: Active-Backup, MAC pinning (default), or LACP. LACP needs an MLAG toggle; LACP without MLAG across two switches is a misconfiguration.
  - **Multipath policy:** active-active (default) or active-passive. This is an `assumption` until lab L12.
  - **VLAN placement:** strict A/B (default) or tagged on both switches.
    - In strict A/B, a node NIC failure can't be saved by the bond: the VLAN-A vNIC has nowhere to go, so the VLAN-A paths are lost through keep-alive and multipath carries the IO on VLAN B.
    - **MAC-pinning placement is VLAN-aware** (`assumption`): a storage vNIC is pinned, rebalanced and failed over only onto a member whose switch carries its VLAN. Without this, the vendors' reference design (MAC pinning + isolated VLANs) would strand vNICs on rebalance. An "OVS-literal" toggle shows that hazard.
    - Bonded-lab validation is needed; the test drive is single-NIC.
  - **Single-VLAN** misconfiguration.
  - **MTU** 1500 vs 9000 mismatch.

**T2 default: Nutanix HCI on AHV**

- **4 nodes** (FT1, RF2) with 2 × 25 GbE per node, one NIC to each ToR, active-backup on `br0`.
- The two ToRs are joined by an ISL.
- A 5-node RF3 / FT2 variant is an option, as is a 3-block layout for block awareness.

**T3 default: dedicated compute + dedicated storage**

- **3 CO nodes and 4 SO nodes** (FT1, RF2). Two ToRs with an ISL.
- Every node has 2 NICs in a bond, and the bond mode can be changed at runtime (§5.5).
- **Variants:**
  - **CO + HCI:** 2 CO nodes + 4 HCI nodes, so some VMs have local CVMs and some don't.
  - **CO single-NIC:** shows why CO uplinks carry storage IO.

**T1-lab: the test drive mirror**

- Same as T1, but each node has a **single NIC, with no uplink bond**. The storage segments are tagged on that NIC alongside management.
- The FA has **extra data IPs** (more interfaces or VLAN interfaces per controller), so array-side path failures can be injected by disabling individual FA IPs.
- Node and version counts are set to match the lab once known.

The layout is stored in the topology data. A dev-only **layout edit mode** lets the owner drag nodes and click "Copy layout JSON", which replaces the reference's hand-exported positions.

---

## 7. Scenarios

### 7.1 Format [DECIDED]

```ts
export default defineScenario({
  id: 't1-switch-a-fail',
  title: 'Storage switch A fails',
  topology: 't1-ahv-flasharray',
  options: { fabric: 'strict-ab' },
  timeline: [
    { at: 0,  action: { kind: 'switch.fail', target: 'sw-a' } },
  ],
  expect: [
    { at: 6,  that: s => allCvms(s, c => c.nvme.pathsUp === 2) },
    { at: 10, that: s => allVms(s, v => v.state === 'running') },
    { always: s => noVmRunningTwice(s) },
  ],
  // version omitted → newest Nutanix + newest supported Purity//FA
  narrative: 'Each CVM loses its two VLAN-A paths. When the keep-alive times out ...',
  cite: ['fa-net-bp', 'nvme-tcp-bp'],
});
```

The same file serves two uses:

- **Vitest.** `tests/scenarios.test.ts` globs `src/scenarios/**` and generates one test per file. It also takes a golden snapshot of the event-log codes, so behavior changes show up in review.
- **UI.** The scenario picker plays the timeline, with a pause at each step, as a guided tour with the narrative.

**Property tests (fast-check).** Random action sequences on each topology must keep these invariants:

- no VM is running on two hosts
- no write is acknowledged with fewer than RF live replicas, unless the model reports it as degraded
- the ZK quorum side is unique
- IO is never served by a fenced host
- the engine is deterministic: same seed, same log

### 7.2 Initial scenario backlog (v1)

T1 (AHV + FlashArray):

1. One storage NIC fails on a node, in strict A/B mode vs trunked mode.
2. Storage switch A fails.
3. FA primary controller crashes.
4. FA secondary controller crashes.
5. Purity NDU (secondary reboot, then giveback, then primary reboot).
6. FA primary IO stall triggers a giveback.
7. An AHV host loses power, and HA restarts its VMs by T+120.
8. A CVM fails while the host stays alive.
9. A node loses both storage uplinks but keeps `vs0`. Hades puts the node in maintenance mode and its VMs move to a remote Stargate; a lab variant with Hades maintenance off shows the retry-in-place default. **[OPEN-6]**
10. Both storage switches fail, or the whole array is lost, for less than a guest can wait. Every node tries Hades maintenance mode but only N−2 are admitted; VMs stall and resume in place once the array is back and the services re-form.
11. Misconfiguration: single storage VLAN, then a switch failure.
12. Misconfiguration: MTU mismatch.
13. The FA mgmt API is unreachable, so snapshots fail while IO continues.
14. **Bond comparison, steady state.** The same VM under Active-Backup, MAC pinning and LACP, showing which uplinks its vDisk's paths and connections use, combined with the active-active and active-passive multipath policies.
15. **Bond comparison, one node NIC down.** In each mode, check whether any NVMe path is lost, how long the blip lasts, and how the load redistributes.
16. **MAC pinning + strict A/B.** A rebalance pins the VLAN-A vNIC to the uplink on Switch B, and its paths blackhole with no hardware failure (misconfiguration).
17. **LACP across two switches without MLAG** (misconfiguration).
18. **LACP slow rate with a hung switch** (no carrier loss): hashes blackhole for up to 90 s, compared with about 3 s on the fast rate. The slow variant is a host rate set outside Prism.
19. Misconfiguration: switch flow control (PFC or global pause) enabled.
20. **Hung Switch A with every host's `vs0` active on it** (OVS default). No bond notices, CVM-to-CVM traffic is lost cluster-wide, Zookeeper quorum is lost and writes stop, although the NVMe paths through Switch B are healthy. No HA restarts. Powering Switch A off fails every `vs0` over and the cluster recovers.
21. **Hung Switch A with `vs0-active-member: alternate`.** Nodes 1 and 3 are each isolated. They hold two of the three ZK seats, so nodes 2 and 4 regain quorum (N−2) only when the seats move, after 300 s. The new leader then marks the isolated hosts disconnected and their VMs self-terminate. AHV HA fences the hosts 40 s later and restarts the VMs 60 s after that.
22. **Silent path loss, queue-depth-bound guest.** One FA IP goes silent under the default queue-depth selector: a guest whose queue depth fits in the dead path's IO queues stalls completely until the stuck IO is abandoned, then resumes on the surviving paths with no error; a deep queue stalls only partially (§6.4c item 3).
23. **Short FA port flap** (3 s and 20 s). The target resets the stale connections when the port returns, so the stuck IO is retried at once: the stall is about the outage, followed by a normal reconnect.
24. **Lossy FA port cable** (grey failure). No path is declared failed; IO sees multi-second outliers until an IO timeout retries elsewhere and resets the path; the path is used again once the loss is removed.
25. **Slow FA port cable** (added latency), queue-depth vs round-robin: queue-depth shifts share away from the slow path but keeps using it; round-robin keeps an equal share.
26. **Whole array lost for minutes**, `whole-array-loss-vm-behavior` crash-and-restart vs stall: maintenance is admitted for only N−2 nodes; VMs crash after `guest.ioStallCrashS` and AHV HA restarts them after the array returns, or they stall in place.

T2 (HCI AHV):

1. CVM power-off triggers Autopath; failback after 300 s stable, much slower than the failover.
2. Host power loss: fence at T+60, restart at T+120, rebuild from about T+80 (about 64 min), ring detach at 30 min mid-rebuild.
3. Host network isolation, with isolated VMs self-terminating at 45 s.
4. The host running the Acropolis leader fails.
5. Single uplink or ToR failure with active-backup bonds.
6. LACP fast vs slow member failure.
7. Single disk failure.
8. Second node failure on FT1 after the rebuild finishes vs during it.
9. Two concurrent node failures on FT2.
10. Block failure with block awareness met vs not met.
11. A 3/2 partition on a 5-node cluster.
12. Total partition (both ToRs down): no quorum anywhere, VMs self-terminate 45 s after their first failed IO, and the new leader restarts them when the network returns.
13. **Degraded Node Detection.** A CVM's network flaps; after the scoring window it is marked Degraded (metadata store in forwarding mode, FT reduced). A second CVM outage then takes cluster storage down; marking the node fixed brings it back.

T3 (CO + SO / CO + HCI):

1. An SO node fails. Rebuild starts, there is no VM HA event, and CO VMs whose Stargate was on that node are redirected.
2. A CO node fails. AHV HA restarts its VMs on another CO node, or on an HCI node in the CO + HCI variant.
3. A CO node loses one NIC. The outcome depends on the bond mode (Active-Backup, MAC pinning or LACP), and storage IO is affected, unlike on HCI.
4. A CO node loses all uplinks. Storage IO stops at once; then isolation and HA follow.
5. The same NIC failure on an HCI node vs a CO node, side by side. HCI VM IO keeps flowing to the local CVM; CO VM IO does not.
6. Change the bond mode mid-scenario under load, and watch path and uplink usage redistribute.
7. Misconfiguration: too few CVM nodes for the configured FT, or CO nodes outnumbering HCI nodes 2:1 (advisory warning).

T1-lab:

1. Disable one FA data IP. That path is lost, and IO continues on the others.
2. Disable all FA IPs on one storage VLAN. Every CVM loses those paths.
3. Prune the storage VLAN on one node's switch port. That node loses all its array paths while keeping management, which tests the path-loss handling with and without the per-VM force-shutdown timeout.
4. Prune VLAN 10 on one array port's switch port, so every CVM loses one path silently, under the queue-depth vs the round-robin path selector: partial stall vs full stall for ≈ 3 × KATO + CQT (§6.4c).

---

## 8. Visualization and UX

**Layout**

- A header carries the brand, the topology picker, the sim clock `T+mm:ss` and the time controls.
- The **diagram** fills the center.
- The right rail is tabbed: **Inspector** (selected device's view and actions), **Events** (filterable log with causal links), **Explain** (narrative and citations with confidence badges) and **Scenario** (guided steps).

**Diagram**

- Nested groups are Site → Cluster → Node → (AHV host, CVM, NICs), and FlashArray → Controller → Ports.
- Switches have per-port handles.
- Status colors come from tokens: healthy, degraded, failed, fenced and unknown.
- Leaders get badges (ZK, Acropolis, FA primary).

**Packets**

- One canvas overlay is driven by `requestAnimationFrame`.
- Every cable that carried traffic within the activity window shows a continuous stream of dots, one stream per category and direction (`link-flow.ts`). Dots move at a fixed, slow on-screen speed (60 px/s at zoom 1, about one cable per 2–5 s, as in ActiveClusterVis) on wall-clock time, so they keep moving while paused and do not speed up at ×20 or ×60. Streams fade as their traffic ages out of the window, and none is drawn on a cable that is down.
- Dots are colored by category. A new drop shows a one-off red burst at `dropAt`; a persistent drop (to something that is down, or the same site and reason as last tick) shows a steady red × instead, and its stream stops there.
- Hovering a link lists recent traces.
- Animation is cosmetic: it replays traces and never feeds back into the engine.

**Interaction**

- Clicking a node or edge selects it, and its applicable actions appear in the Inspector. A right-click context menu gives quick fail and recover.

**Sharing**

- The topology, options, seed and action log are encoded in the URL hash, which allows a "Copy share link" button and reproducible bug reports.

**Accessibility**

- Status is never shown by color alone; icons and labels accompany it.
- The overlay respects `prefers-reduced-motion`, falling back to edge highlight only.

**Branding** [DECIDED]

- Use **"Everpure"** for the array vendor (for example "Everpure FlashArray") and "Nutanix" descriptively.
- The visual style is clean and neutral. No vendor logos are used until trademark use is cleared (**[OPEN-3]**).

**Version selector**

- Header dropdowns: the Nutanix version, then the FlashArray version (supported versions only), as described in §2.1.
- Changing either version resets the simulation, after a confirmation if actions have been applied.

---

## 9. Quality gates and CI

**PRs** must pass `biome ci`, `tsc --noEmit`, `vitest run` (unit, scenario and property tests) and a Playwright smoke run (Chromium: load each topology, apply one action, screenshot).

**`main`** additionally runs `vite build` and deploys to GitHub Pages.

**Coverage targets:**

- **Domain:** every modeled timer has at least one test that exercises its boundary (it fires at T, not at T−1).
- **Scenarios:** every scenario in §7.2 exists as a scenario file before its feature is called done.

---

## 10. Milestones

| M | Deliverable | Exit criteria |
|---|---|---|
| M0 | Scaffold: Vite + React + TS 7 + Biome + Vitest + Playwright + Tailwind/shadcn, CI, Pages deploy, CLAUDE.md commands | Empty app deployed. CI green. |
| M1 | Engine core: clock, timers, device tree, VLAN L2 + bonds, messaging rounds and traces, actions, snapshots, event log, seeded RNG | Engine unit tests. Determinism property test. Headless demo topology. |
| M2 | FlashArray + NVMe/TCP initiator + minimal CVM/Stargate + VM IO (topology T1, networking and array scenarios 1–6, 10–12) | T1 scenarios pass headless. |
| M3 | UI: React Flow diagram, geometry, packet overlay, inspector, actions, time controls, event log | T1 interactive on Pages. Playwright smoke passes. |
| M4 | Nutanix cluster services: ZK, Cassandra ring, Acropolis/AHV HA, fencing, cluster status (T1 7–9, 13) | AHV HA timeline tests at T+20/60/120. |
| M5 | HCI data path: extent groups, RF, Oplog replication, Autopath, Curator rebuild, disks (topology T2) | T2 scenarios pass. |
| M6 | Explain panel, guided scenarios, share links, polish and branding, visual baselines | Owner review. |
| M7+ | 2-node + Witness, ActiveDR/async, capacity, Metro, and new version profiles as releases ship | — |

---

## 11. Risks

- **Undocumented behavior.** The biggest risks are T1 single-CVM total path loss, VM behavior on full array loss, and the AHV CVM redirect pause. Mitigation: confidence labels, isolated assumptions in named constants, and the open questions in §12 to take to Nutanix and Pure engineering.
- **Confidential sources, public repo.** Some T1 details are documented only in internal Everpure material.
  - `docs/internal/` is git-ignored and is never cited.
  - Those values are replaced by labeled `assumption` values.
  - Add a CI check that greps for internal URL hosts (slack, jira, internal Google Docs) in tracked files.
- **React Flow compound and edge layering.** Mitigation: the geometry module is ours, and Cytoscape is the documented fallback.
- **TS 7 ecosystem gaps.** Mitigation: use Biome rather than typescript-eslint. If a tool needs the TS API, add the `@typescript/typescript6` alias.

---

## 12. Open questions for the owner

Questions 1, 2, 4 and 5 are resolved: AHV only, public repo, React, and the newest release through the version selector.

3. **Logos.** Are any Everpure or Nutanix logos or brand assets cleared for use?
6. **T1, one CVM loses all NVMe paths.** The deployment guide says IO retries until the array responds, unless a per-VM force-shutdown timeout is set. Before that point, does the iSCSI redirector move VM IO to a remote CVM whose Stargate still has paths, or does the VM stall? The default model is a stall, labeled `assumption`.
7. **T1, full array loss.** Do VMs pause, or do guests see IO errors, and when? Is there a public source for the integration's NVMe keep-alive, reconnect and controller-loss values and its path policy?
8. **T1 bond default.** The proposal is MAC pinning (Everpure KB) with both VLANs tagged on both switches, with LACP and strict A/B as options. Confirm this, or pick LACP (Nutanix's preference).
9. **Scope.** Is ActiveCluster or ActiveDR wanted in v1, or later?

---

## 13. Implementation plan: parallel workstreams

The work is split so several agents (or people) can build at once. Each one works in its **own git worktree and branch** and **owns a disjoint set of directories**. The main thread acts as **integrator**: it owns the shared contracts, reviews, merges to `main` behind CI, and resolves cross-stream questions.

### 13.1 Rules for parallel work

1. **Contracts first.** Nothing runs in parallel until Phase 0 has merged the shared contracts. These are the only files that more than one stream depends on:
   - `src/engine/types.ts`: the Device hooks, Message, Trace, Event, Snapshot, Action and Timer APIs.
   - `src/domain/versions/profile.ts`: the Profile type.
   - `src/topologies/schema.ts`: the Zod schema.
   - `src/scenarios/define.ts`: the scenario format.
   - `tests/fixtures/snapshots/*.json`: sample snapshots the UI can render without an engine.
2. **Exclusive ownership.** A stream edits only the paths it owns. If it needs a contract change, it asks the integrator, who makes the change on `main`, and the streams then rebase. Streams never edit each other's directories.
3. **Every stream lands with tests**, and CI must pass: Biome, `tsc`, Vitest, plus Playwright for UI streams.
4. **Accuracy rules apply to every stream** (§2): public citations only, confidence labels, and current-release behavior only.
5. **Small merges.** Each stream merges whenever it has a working, tested slice, so later streams can build on real code instead of stubs.

### 13.2 Phases and streams

```
Phase 0 (serial)      P0 scaffold + contracts
                              │
Phase 1 (parallel)    ┌───────┼────────┬──────────┬───────────┐
                      A engine B UI     C versions D topologies H scenarios
                      core     shell    +citations  +layout     (test-first)
                      │        (fixture  │          │           │
                      │         data)    │          │           │
Phase 2 (parallel)    ├──────┬──────────┴──────────┘           │
                      E FA + F Nutanix services + workload      │
                      NVMe   └──► G HCI data path (after F's    │
                      │           Stargate contract)            │
                      │                                         │
Phase 3 (serial-ish)  I integration: engine↔UI bridge, explain panel, share links,
                        enable H's scenarios, Playwright visual baselines, polish
```

| Stream | Phase | Owns | Delivers | Depends on |
|---|---|---|---|---|
| **P0** Scaffold + contracts | 0 | repo root config, `.github/`, the contract files listed above, `tests/architecture.test.ts` | Vite/React/TS7/Biome/Vitest/Playwright/Tailwind/shadcn, CI + Pages deploy, contracts, boundary test, CLAUDE.md commands | — |
| **A** Engine core | 1 | `src/engine/**` (except `types.ts`), `tests/engine/**` | clock and timers, device tree, VLAN L2 + bonds (active-backup / MAC pinning / LACP fast-slow), messaging rounds and traces, actions, snapshots, event log, seeded RNG, determinism property test | P0 |
| **B** UI shell + diagram | 1 | `src/ui/**`, `tests/e2e/**` | theme and branding, layout, React Flow node and edge types, `geometry.ts` (+ unit tests), Canvas packet overlay, version selector, inspector, event log and time-control panels. All of it is driven by the **fixture snapshots**. | P0 |
| **C** Versions + citations | 1 | `src/domain/versions/**`, `src/domain/citations.ts`, `docs/research/**`, CI public-source check | version matrix (newest AOS → supported Purity//FA), the current-release profile with every timer cited and labeled, a CI grep that blocks internal URLs | P0 |
| **D** Topologies + layout | 1 | `src/topologies/**` | T1, T1-lab, T2 and T3 (CO+SO, CO+HCI) default topologies plus option variants (strict A/B vs ISL, LACP vs MAC pinning, single-VLAN, MTU mismatch, 5-node), positions, layout-edit "copy JSON" helper (coordinates with B) | P0 |
| **H** Scenarios (test-first) | 1→3 | `src/scenarios/**`, `tests/scenarios.test.ts`, `tests/invariants.test.ts` | every §7.2 scenario written up front as `it.todo` / expected-fail, with narrative and citations; switched on as E/F/G land; fast-check invariants | P0 (format), then E/F/G |
| **E** FlashArray + NVMe/TCP | 2 | `src/domain/flasharray/**`, `src/domain/nvme-tcp/**` | controllers (primary/secondary claim, promotion, IO delay timeout, NDU, port disappearance), FE ports, ANA all-Optimized, mgmt API endpoint, host-side initiator (keep-alive, reconnect, controller-loss) | A, C |
| **F** Nutanix services + workload | 2 | `src/domain/nutanix/**` (except `hci/`), `src/domain/workload/**` | CVM, Stargate (interface + T1 NVMe backend), ZK ensemble, Cassandra ring, Acropolis/AHV HA (T+20/60/120, fence, 45 s self-terminate), iSCSI redirector (incl. CO nodes with no local Stargate), node roles (HCI / CO / SO), T1 node-failure tolerance (N−2 / N−3), per-VM path-loss handling, VM and vDisk lifecycle | A, C |
| **G** HCI data path | 2 | `src/domain/nutanix/hci/**` | extent groups and RF placement (block awareness), Oplog sync replication, Curator rebuild, disks (SMART, 3 offline events per hour), 95% read-only | F's Stargate interface (an early F merge) |
| **L** Lab validation | 1→3 | `docs/research/lab-validation-plan.md`, lab results, and the `confidence` fields in profiles (coordinated with C) | experiments L1–L11 on the test drive instance; assumptions upgraded to `lab-observed`; golden expectations for H | lab access and owner approval of which disruptive actions are allowed |
| **I** Integration + polish | 3 | `src/ui/store/**` bridge, `src/app` wiring, explain panel | engine↔UI `useSyncExternalStore` bridge, live diagram, explain panel with citations and confidence badges, guided scenarios, share-link URL state, visual baselines | all |

**Peak parallelism.** Phase 1 runs 5 streams (A, B, C, D, H) and Phase 2 runs 3 (E, F, G, with G starting once F's interface lands). With an AI orchestrator, each stream is one agent in an isolated worktree, and the integrator merges between phases.

### 13.3 What makes this safe

- **Exclusive ownership.** The directory ownership table means two streams never edit the same file.
- **Fixtures decouple the UI.** B never waits on A, E, F or G, because it renders checked-in snapshot fixtures that conform to `Snapshot` in `types.ts`.
- **Scenarios are the acceptance tests.** H's scenario files are the shared definition of done for E, F and G. A stream is finished when its scenarios turn green.
- **The architecture test enforces the layers.** It fails CI if `engine/` imports `domain/` or `ui/`, or if `ui/` mutates engine state.

### 13.4 Prerequisites

- **Before P0:** the directory has to become a git repo (`git init` plus an initial commit of the docs), because worktrees need one.
- **GitHub remote:** creating it (presumably `NutanixVis` under the owner's account) and enabling Pages, with the source set to Actions, is an outward-facing step that needs the owner's go-ahead.

---

## 14. Scenario decisions (integrator, 2026-10-27)

Stream H raised these while writing the acceptance scenarios. Each is labeled with its confidence. Items marked **(owner)** need the owner's confirmation.

| # | Question | Decision | Confidence |
|---|---|---|---|
| 1 | Total partition: no side has a quorum majority (T1-10 both switches; T2-12 both ToRs). | No fencing and no HA restart while no quorum exists. **T1:** VM IO **retries until the array responds** (DEPLOY-GUIDE), so VMs are `io-stalled` and do not self-terminate. Every node tries Hades maintenance mode (only N−2 are admitted), and the VMs resume in place once the fabric returns and the services re-form; an outage longer than `guest.ioStallCrashS` crashes them instead and AHV HA restarts them afterwards (#13). **T2/T3:** a VM whose IO fails self-terminates 45 s after its first failed IO (Bible 5b ties the rule to IO failure, `inferred`). When quorum re-forms, the new Acropolis leader restarts the VMs that were running (anecdotal: public r/nutanix thread, "the system will return to its previous state"). | `inferred` / anecdotal **(owner)** |
| 2 | T1-05 NDU: controller reboot time, and the final primary. | Add `flasharray.controllerRebootS` to the profile (`assumption`). The upgrade does **not** fail back: the controller upgraded first ends as primary. | `assumption` / `inferred` |
| 3 | T1-17: LACP without MLAG. | Follow the engine's OVS-like behavior: only members to one partner aggregate (`lacpState: partial`). Redundancy is lost but traffic is not blackholed. | `inferred` |
| 4 | T1-18 / T2-06: slow LACP with a hung member. | **T1:** if the path's admin-queue connection hashes to the hung member, keep-alive fails, the path is lost after KATO, and IO continues elsewhere. Stuck IO-queue connections wait for an NVMe IO timeout, a new profile field `externalStorage.ioTimeoutS` (`assumption`). **T2:** if host-management flows blackhole past the 40 s disconnect timeout, AHV HA triggers (AHV Admin Guide). | `inferred` + `assumption` |
| 5 | T3-01: a CO host's redirector detecting a dead remote Stargate. | Same NOP/miss/window timers as for a local Stargate. | `inferred` |
| 6 | T3-07: configured FT for T3. | Add `replication-factor` (2 / 3) to T3 topologies. RF/FT count only CVM-bearing nodes. | decided |
| 7 | T1-lab-3: what starts the force-shutdown timer, and the restart delay. | Counts from the **first IO that could not complete** on that VM. On expiry the VM is powered off and restarted through AHV HA on a node with array connectivity, at the next HA cycle. | `assumption` (lab L2) |
| 8 | T2-04: initial Acropolis leader. | Deterministic: the lowest node id (`node-1`). | decided (model) |
| 9 | CVM boot time. | Add `cluster.cvmBootS` to the profile (`assumption`). Failback is still gated by the `failbackStableS` (300 s) stable rule after `stargate.up`. | `assumption` |
| 10 | T1-20: what a hung switch does to `vs0` active-backup. | Nothing detects it (OVS checks carrier only; AHV's gateway checks run only during vswitch changes). With every host active on the hung switch, ZK quorum is lost at once, writes stop and HA does nothing. Recovery only through carrier loss: power-off or port admin-down. | `verified` (no detection) / `inferred` (cluster effect) |
| 11 | T1-21: HA timeline for hosts isolated by a hung switch. | The existing AHV HA model: leader re-election at T+20 when the leader host is isolated, disconnected at T+20, fenced at T+60, isolated VMs self-terminate 45 s after the first failed IO, restart by T+120. The AHV Admin Guide's "disconnected for 40 seconds, the VMs are restarted" would let restarts begin at T+60; the model restarts at the Bible's T+120 bound. | `inferred` |
| 12 | Behavior over exact timing: what order things happen in, and at what rough scale. | The model keeps this relative order (fast → slow): a redirect after a clean Stargate stop (about a second) < abandoning IO stuck on a silently lost path (3 × KATO + CQT, about 45 s) < Hades maintenance (path-loss detection, the abandoned check IO and the 5 s threshold, about a minute) < the vDisk handover to a remote Stargate (`vdiskHandoverS`, 60 s) < an AHV HA restart (120 s) < redirector failback (300 s stable) < Degraded-node auto-resolve (`dnd.autoResolveHealthyS`). Values are cited profile values or labeled `assumption`s chosen to keep that order. | decided |
| 13 | Whole-array loss: what VMs do (`whole-array-loss-vm-behavior`). | `crash-and-restart` (default): VMs whose IO stalls past `guest.ioStallCrashS` crash (QEMU exits, "VM shut down unexpectedly") and AHV HA restarts them after the array returns. `stall`: IO retries in place, the DEPLOY-GUIDE wording. Only N−2 (N−3) nodes are admitted to Hades maintenance at once; the rest keep trying. | `assumption` **(owner)** |
| 14 | Silent path loss under the queue-depth selector. | Full stall when the guest's queue depth is at most the number of IO queues the dead path holds; partial stall for deeper queues; round-robin stalls fully at any depth (§6.4c item 3). | `assumption` |
| 15 | Port flap, lossy link, slow link. | The target drops a port's connections when it loses link and resets later frames of them, so stuck IO is retried at once; an IO timeout resets the path; keep-alive is traffic-based; the queue-depth selector weighs path latency (§6.4c). | `assumption` / `inferred` |
| 16 | Degraded Node Detection. | A CVM unresponsive to its peers and responsive again by the end of `dnd.scoringWindowS` is Degraded: metadata store in forwarding mode, FT reduced, alert; cleared after `dnd.autoResolveHealthyS` or `cvm.mark-fixed` (§6.2). | `assumption` |

### Phase 2 contract backlog (from stream H)

- **New actions:**
  - `vm.snapshot` (T1-13), owned by the FlashArray domain.
  - `vswitch.rebalance {vnic, member}` (T1-16), owned by the engine bond runtime, so the stranded-vNIC case is deterministic.
- **New option:** `path-loss-force-shutdown-s` for T1 and T1-lab. It sets `vm.pathLossForceShutdownS` on all VMs.
- **New profile fields:** `flasharray.controllerRebootS`, `externalStorage.ioTimeoutS`, `cluster.cvmBootS`.
- **View fields:** the view-field contract in `docs/view-fields.md` is adopted. Domain streams must produce those fields and event codes.

---

## 15. Field deployment input (2026-10-27)

Owner-supplied field practice from deployment walkthroughs. The full comparison of designs, with pros and cons, is in `docs/research/storage-network-configs.md`. Setup and verification commands are in `docs/commands.md`.

### 15.1 Storage network layout: three supported shapes, all modeled

| Layout (`storage-vswitch-layout`) | Shape | Source | What a node NIC failure does |
|---|---|---|---|
| `single-bond` + MAC pinning (default) | One storage vswitch, both NICs, Active-Active MAC pinning | Everpure NET KB, Cisco Validated Design | Strict A/B: that VLAN's paths are lost after KATO (§6.4c). Tagged-both: the bond saves the path. |
| `single-bond` + LACP | One vswitch, LACP over MLAG | Nutanix deployment guide ("LACP when available") | The hash moves; LACP fast/slow detection only applies to failures without carrier loss. |
| `per-fabric` | **One vswitch per fabric, each "No Uplink Bond"** with one NIC and one storage segment (VLAN). Multipathing is left entirely to NVMe. | Field practice, AHV Admin Guide (No Uplink Bond), NET KB (no-bond allowed as an exception) | That fabric's paths are lost after KATO; IO continues on the other fabric. There is no bond layer at all. |

- **ISL.** Field practice keeps storage VLANs **off the ISL** (single hop from node to array; the ISL adds latency and can become a bottleneck). The Cisco Validated Design allows storage traffic on the ISL. The option `isl-storage-vlans`: pruned | allowed.
- **Switch ports.** FA data ports are typically access ports (untagged) on the switch, while node ports are trunks.
- **MAC pinning + isolated VLANs.** With isolated VLANs, `per-fabric` and VLAN-aware MAC pinning reach the same failure outcome, by different mechanisms.
- **`vs0` and a hung switch.** No storage layout protects management: `vs0` is Active/Backup, which never detects a hung switch. Which switch each host's `vs0` is active on decides whether a hang costs the whole cluster (T1-20) or only the hosts on that switch (T1-21). See `docs/research/storage-network-configs.md`, "The hung switch and `vs0`".

### 15.2 Backlog from field input

- **Build-up action `storage.create-internal-interface`.** Creating an External Storage internal interface runs a cross-CVM network validation over the new segment. A VLAN or trunk misconfiguration makes the task fail and roll back ("network validation failed"). Model it as a build-up step whose success depends on L2 reachability between CVMs on that VLAN. Confidence: `inferred` from field observation.
- **Jumbo frames.** Field practice treats MTU 9000 as required on the storage vswitch and interface. The deployment guide calls it recommended, with a 1500 default. The existing `mtu` option covers both; scenario narratives should say that 9000 end to end is the norm.
- **Pod quota counts provisioned size, not used size** (DEPLOY-GUIDE also warns about quota limits). Add a misconfiguration scenario: VM or disk create fails once provisioned capacity exceeds the quota, while running IO is unaffected.
- **UI: vDisk → FA volume name.** Prism Central shows each vDisk's backing FA volume name. Show it in the VM and vDisk inspector.
- **Version notes.** Purity 6.12.0 is the minimum, and **6.12.1+ is recommended** (shown in the selector label). **R3 arrays cannot run 6.12.x**, so they use 6.11.8; backlog: an FA model/generation topology option that filters the FlashArray list. Upgrade Purity first and never upgrade both at once; this is backlog for a guided NDU/upgrade scenario.
