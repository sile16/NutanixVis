# Project status

Living status page: where the project stands, what is left, which behavior still needs checking against a real lab, and lessons learned along the way. Update it at the end of each work session.

**Last updated:** 2026-10-28

## Where things stand

- **Live site:** https://sile16.github.io/NutanixVis/ (GitHub Pages, deployed from `main` once `check` and `e2e` pass).
- **Topologies:**
  - T1: AHV compute with an Everpure FlashArray over NVMe/TCP.
  - T1-lab: the single-NIC mirror of the test drive.
  - T2: Nutanix HCI.
  - T3: compute-only plus storage-only, and compute-only plus HCI.
- **Scenarios:** 61 run as automated tests against the real models. All are `active`, so a behavior change that breaks one fails CI.
- **Tests:**
  - About 840 unit, contract, architecture and property tests (Vitest and fast-check).
  - 29 browser tests (Playwright), including the T1 visual baseline.
  - All green.
- **Models in place:**
  - Network: VLAN-aware L2, and the bond modes active-backup, balance-slb (MAC pinning) and balance-tcp (LACP), with MLAG and hung-switch detection.
  - NVMe/TCP initiator: KATO, CQT, reconnect and controller loss.
  - FlashArray: controllers, ANA and failover.
  - Nutanix cluster: Zookeeper quorum, Acropolis leader, AHV HA, the redirector/Autopath, and CVM and Stargate lifecycle.
  - HCI data path: RF, oplog replication and Curator rebuild.
  - Compute-only and storage-only nodes.
- **Behavior data:** every timer and policy lives in `src/domain/versions/profiles/current.ts` as a cited field with a confidence label. Lab results become data changes, not code changes. `docs/research/profile-coverage.md` lists them all.

### Recent changes

- **2026-10-28: traffic dots.** Dots now stream slowly and continuously along every active cable, at about one cable per 2–5 s, as in ActiveClusterVis. They run on wall-clock time, so they keep moving while paused and no longer race at ×20 or ×60. Streams fade as traffic ages out of the activity window. Drops still burst once or show a steady ×. Code: `src/ui/diagram/link-flow.ts`.
- **2026-10-27: UI bug hunt.**
  - A failed host now drives its children and cables to failed.
  - Drop markers are steady instead of blinking.
  - VMs restarted by HA are drawn on their new host, with a restart marker.
  - Per-VM path usage.
  - Traffic-type filter.
  - The FlashArray VIP follows failover.
  - MLAG pairing and action applicability fixes.

## To do

### Polish (small)

- **T3 layout:** seven hosts in one row get small at the default zoom. Wrap them into two rows.
- **FlashArray interfaces:** the FA interface boxes are a bit narrow.
- **HA restart timing:** VMs on the Acropolis leader's own host restart one tick later than VMs on other hosts (T+122 against T+121). Make it consistent.
- **`action.rejected`:** carry the action kind and target as structured fields, not only in the message.
- **CVM service chips:** show Stargate, Zookeeper and Cassandra status on the CVM card.

### Waiting on a real lab

- **Lab with paths:** the test drive lab has too few paths for path-failover testing, and a better lab is being found. When it is ready, run `docs/research/lab-validation-plan.md` (L1–L13).
- **Recording results:** mark each value `lab-observed`, with the AOS, AHV and Purity versions and the date, and update the matching scenario expectations.

## Behavior to double-check

Each item names the profile field or model rule it affects. Until it is confirmed, the model uses the labeled assumption shown here. Research notes for each question are being gathered, and the outcome will be recorded here and in `docs/research/`.

| # | Question | Model today | Where | Lab |
|---|---|---|---|---|
| Q1 | Is about 32 minutes realistic for rebuilding a 4-node RF2 HCI cluster after a node failure (20% full)? | 1 GiB/s per surviving node, 20% fill | `hci.rebuildGiBpsPerNode`, `hci.initialUsedCapacityPct` | none yet |
| Q2 | During the KATO window (5 s), can a guest's whole IO queue get stuck on the dead path, so the guest sees a stall of up to KATO + CQT (about 35 s) and not just latency outliers? | Only IO in flight on the dead path is held, for CQT, then retried | SPEC §6.4c, `workload/io.ts` queue depth | L5 |
| Q3 | Does the integration set an NVMe IO timeout? SPDK's default is disabled. | 30 s | `externalStorage.ioTimeoutS` | L5 |
| Q4 | What is the Zookeeper session timeout? How long do cluster services keep running when both switches fail, or when the whole array is lost? | Not timed. Services follow quorum. | `cluster.*` | L9 |
| Q5 | What does Prism show for HA and cluster status when quorum is lost? | HA status is shown as the model computes it | `ClusterView` | L9 |
| Q6 | A hung Switch A (link up, forwarding nothing) takes down the T1 management backplane through `vs0` active-backup. Should it be a scenario of its own? | Modeled. No dedicated scenario yet. | `bond.ts`, scenarios | L4-style (bonded lab) |
| Q7 | Is `network_segment_status --last_task` the CVM command behind Prism's "Review Network Log"? | Labeled inferred in `docs/commands.md` | docs | any lab |
| Q8 | Multipath policy and IO queues per path: active-active round robin with 4 queues? | Both are assumptions | `externalStorage.multipathPolicy`, `ioQueuesPerPath` | L12 |
| Q9 | What is the reconnect delay after a path is lost? | 20 s (the SPDK example value) | `externalStorage.reconnectDelayS` | L5 |
| Q10 | How long does IO pause during a redirect, and how long until failback? | 3 s pause, failback after 30 s stable | `redirector.redirectStallS`, `failbackStableS` | L3 |
| Q11 | How long do a CVM boot, a host reboot and a Cassandra rejoin take? | 180 s, 300 s, 600 s | `cluster.cvmBootS`, `hostRebootS`, `cassandraRejoinStableS` | L7 |
| Q12 | How long do disk SMART checks and the replica-ack timeout take? | 10 s, 2 s | `hci.diskSmartCheckS`, `replicaAckTimeoutS` | none yet |
| Q13 | How long does a FlashArray controller reboot take during an upgrade? | 300 s | `flasharray.controllerRebootS` | L6 |

## Lessons learned

**Accuracy and modeling**

- **Path loss is detected by KATO, not carrier.** The CVM's vNIC never sees carrier loss on a physical uplink, so NVMe path loss is detected only by the keep-alive timeout. Don't model "carrier loss means instant failover" anywhere above the AHV host.
- **Bonds rarely save a storage path.** With isolated storage VLANs (the typical design and the default), a bond keeps a path only if the vNIC is tagged with both VLANs and the storage VLANs are allowed on the ISL. ISL pruning is the default, so scenarios that expect a bond to save a path must say `'isl-storage-vlans': 'allowed'`.
- **Active-backup only sees carrier.** A hung switch with its links up is not detected, and LACP only catches it after its timeout (fast 3 s, slow 90 s).
- **Keep values in the profile.** Every timer and policy belongs in the profile with a citation and a confidence label, not in code. That is what makes lab results a data change.
- **Model the current release only.** No historical behavior, no "used to" explanations.

**UI**

- **Aggregate over a rolling window.** A per-tick view of multipath round-robin flickers.
- **Repeated drops get a steady marker.** A peer that keeps sending to a dead host drops a packet every tick at the same port. Draw a steady marker there, not a burst each tick.
- **Animate on wall-clock time.** Traffic animation must be independent of simulation speed. Tying it to the tick window made dots race at high speed and freeze while paused.
- **Propagate failure down the tree.** A failed parent must drive its children (ports, CVM, disks) and their cables to failed. Otherwise the diagram contradicts the model.

**Process and tooling**

- **Run the full browser suite before pushing.** A model fix (MLAG pairing) broke a UI test that had pinned the old, wrong behavior.
- **Linux visual baselines are generated in the CI Playwright container** (`mcr.microsoft.com/playwright:v1.64.1-noble`). macOS baselines don't carry over.
- **Run regex bulk edits on one pattern at a time, then check.** A bulk `todo` → `active` rewrite corrupted a type union.
- **The verify script is `pnpm verify`.** `pnpm ci` is a pnpm built-in.
- **Pushing workflow files needs the `workflow` scope** on the GitHub token: `gh auth refresh -s workflow`.
- **The repo is public.** Run `pnpm check:public` before pushing. Never let vendor PDFs or internal notes (`docs/internal/`, `NutanixDocs/`, `EverpureDocs/`) or their values into tracked files. The only exception is the owner-approved NVMe timers (KATO 5 s, controller loss 3600 s, CQT 30 s).
- **Heavy simulations need longer timeouts in CI.** The test timeout is 30 s, and invariant properties allow 120 s.
