# Project status

Living status page: where the project stands, what is left, which behavior still needs checking against a real lab, and lessons learned along the way. Update it at the end of each work session.

**Last updated:** 2026-10-29 (redirector/initiator detection, vDisk leadership, Stargate failure modes, initiator timeout)

## Where things stand

- **Live site:** https://sile16.github.io/NutanixVis/ (GitHub Pages, deployed from `main` once `check` and `e2e` pass).
- **Topologies:**
  - T1: AHV compute with an Everpure FlashArray over NVMe/TCP.
  - T1-lab: the single-NIC mirror of the test drive.
  - T2: Nutanix HCI.
  - T3: compute-only plus storage-only, and compute-only plus HCI.
- **Scenarios:** 83 run as automated tests against the real models. All are `active`, so a behavior change that breaks one fails CI.
- **Tests:**
  - About 1,010 unit, contract, architecture and property tests (Vitest and fast-check).
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

- **2026-10-29: Stargate failure modes and the VM data path.** The model now shows the sequence and the relative scale of these, with `assumption` values chosen to keep the order (SPEC §6.2 / §7.2):
  - **Who detects a dead Stargate:** the VM's iSCSI initiator, through NOPs. The AHV redirector only answers logins. A reset connection (an orderly stop or a process crash) re-logs in at once; a silent Stargate is found by missed NOPs.
  - **vDisk leadership:** a peer serves a vDisk only after the old Stargate releases it. That is at once after an orderly stop or a crash, but only at its Zookeeper session expiry after a hang, CVM reboot, CVM power-off or CVM isolation, so the first redirect parks until the next NOP cycle.
    - Ordering of the guest stall: orderly stop ≈ crash ≪ isolation < hang ≈ reboot ≈ power-off.
    - New actions `cvm.crash-stargate` and `cvm.hang-stargate` / `cvm.resume-stargate` (T1-27).
  - **Staggered failback:** after the stability interval, one vDisk per check. A Stargate restart restarts the clock.
  - **Initiator session timeout:** a VM that no Stargate serves for too long crashes and is powered back on.
  - **Whole-array loss** reaches it through cluster-wide Hades maintenance. Silent loss of all paths past the fast-IO-fail time, or a target-side reset of every path (a both-fabric port flap, even a short one), fails the service-volume mounts. A short silent blip only stalls (T1-28).
  - **Long CVM outage:** the host stays schedulable and its VMs are not migrated.
  - **DND:** a fully unreachable node is treated as dead, not Degraded.

- **2026-10-28: behavior mechanisms.** The model now shows the sequence and rough scale of several behaviors it lacked, with values that are cited profile fields or labeled `assumption`s chosen to keep a sensible order (SPEC §14 #12):
  - A queue-depth-bound guest stalls completely on one silent path loss when its queue depth fits in the dead path's IO queues, even under the queue-depth selector (T1-22).
  - A short FA port flap: the target resets the stale connections, so stuck IO is retried at once (T1-23).
  - Grey failures: `link.set-loss` (latency outliers, then an IO timeout resets the path, T1-24) and added latency (queue-depth shifts share away but keeps using the path, T1-25).
  - Hades maintenance follows path-loss detection by the 5 s threshold; only N−2 nodes are admitted at once; the redirect follows within seconds and the remote Stargate's vDisk handover is about immediate, so IO resumes with no guest timeout. Maintenance ends at the next volume check after the paths return, then the services restart (T1-09).
  - Whole-array loss: VMs crash after minutes of stalled IO and AHV HA restarts them after the array returns, or stall in place (`whole-array-loss-vm-behavior`, T1-26).
  - Redirector failback after 300 s stable (Odgers 2015), much slower than the failover.
  - Degraded Node Detection, and its effect on a second CVM outage (T2-13).

- **2026-10-28: research round.** Four research passes (HCI rebuild, NVMe/TCP, cluster quorum and Prism, AHV networking) answered or narrowed Q1–Q13, and four streams applied them: NVMe hold timing and path selectors, Hades service volumes and ZK seat migration, HCI rebuild and detection timing, vs0 active member and hung-switch scenarios, LACP fallback, and Prism alert IDs. 67 scenarios, about 930 tests.
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

- **Test drive done:** the single-controller test drive lab has been used for everything it can test; its findings are folded in as mechanisms. Lab numbers stay internal (owner decision, 2026-10-29).
- **Still needs a fuller lab:** bond failover on real switches, FlashArray controller failover and NDU, the AOS 7.6 SPDK data path, and MTU mismatch. Run the matching rows of `docs/research/lab-validation-plan.md` (L1–L13) when that lab is ready.
- **Recording results:** mark each value `lab-observed`, with the AOS, AHV and Purity versions and the date, and update the matching scenario expectations.

## Behavior to double-check

Research round 2026-10-28: public docs, KBs, Command Reference gflags, SPDK/Linux source, the NVMe spec and community field reports were checked for every question. Each row below shows what the model does now and its confidence. "Lab" names the experiment in `docs/research/lab-validation-plan.md` that would make it `lab-observed`.

| # | Question | Model today (after research) | Where | Lab |
|---|---|---|---|---|
| Q1 | HCI rebuild time after a node failure | Rebuild starts 60 s after the Stargate is declared down (`inferred`, KB titles), 0.5 GiB/s per surviving node (`assumption`, fits Odgers 2018 tests and "1 to 2 hours" all-flash): ≈ 64 min for 4-node T2 at 20 % fill | `hci.rebuildStartDelayS`, `rebuildGiBpsPerNode` | needs an HCI lab |
| Q2 | Can a guest's whole queue stall on a silently dead NVMe path? | Yes with round-robin at any queue depth, and with the queue-depth selector (default) when the guest's queue depth is at most the dead path's IO queues (full stall ≈ 3 × KATO + CQT ≈ 45 s); deeper queues stall partially. Detection at KATO (traffic-based); in-flight IO held 3 × KATO + CQT (NVMe 2.1 §9.6) unless the target resets the old connection | SPEC §6.4c, `lostPathHoldKatoMultiplier`, `pathSelector` | L5, L12 |
| Q3 | NVMe IO timeout in the integration | 45 s (`inferred`: must be ≥ 3 × KATO + CQT) | `externalStorage.ioTimeoutS` | L5 |
| Q4 | ZK session timeout; services with both switches down / array lost | ZK session 20 s (`inferred`, public CVM logs) delays "services down" and Prism Element; quorum effects immediate. T1: a CVM without array connectivity goes to Hades maintenance mode 5–10 s after keep-alive declares its paths lost (`verified` gflag text, `inferred` trigger); its VMs redirect within seconds and resume at once on the remote Stargate (`assumption` handover), and the node leaves maintenance at the next volume check after the paths return. Whole-array loss takes services down: every node enters maintenance (silent loss past the fast-IO-fail time, or a target-side reset of every path), no Stargate can serve, and VMs crash at the initiator session timeout and are powered back on after the array returns (`assumption`, option `whole-array-loss-vm-behavior`). HCI total partition: VMs self-terminate 45 s after first failed IO and restart when quorum returns (`anecdotal`). Stargate hung-op threshold: not public | `cluster.zkSessionTimeoutS`, `hades.*`, `ahvHa.selfTerminateWithoutQuorum` | L1, L9 |
| Q5 | Prism status without quorum | Prism Element unreachable once services are down; Prism Central raises A200000; partial failures name the real alert IDs (A1001, A1006, A1030, A3032, A111009, A1145, A130068) | ClusterView `prismElement`, `prismCentralAlert` | L9 |
| Q6 | Hung switch with active-backup vs0 | Never detected by active-backup / MAC pinning / no-bond (verified OVS behavior); recovery only by carrier loss. Scenarios T1-20 (all hosts on Switch A: cluster-wide write stall) and T1-21 (`vs0-active-member: alternate`: minority fenced) | `bond.ts`, `vs0-active-member` | bonded lab |
| Q7 | `network_segment_status --last_task` | Bare command documented (AOS Security Guide); `--last_task` flag still unverified — run `--help` in the lab | `docs/commands.md` | any lab |
| Q8 | Multipath policy, queues per path | Active-active (`assumption`) + queue-depth selector (`inferred`); 4 IO queues (`inferred`, Hades gflag) | `multipathPolicy`, `pathSelector`, `ioQueuesPerPath` | L12 |
| Q9 | Reconnect delay | 10 s (Linux default, `assumption`) | `externalStorage.reconnectDelayS` | L5 |
| Q10 | Redirect pause and failback | Detection by the initiator's NOPs (`assumption` interval and count), immediate on a connection reset; a silent Stargate's vDisks wait for its ZK session expiry, then the next NOP cycle; failback after 300 s stable (`unverified`, Odgers 2015 AHV post), one vDisk per check (`assumption`); initiator session timeout then VM crash and power-on (`assumption`) | `redirector.*`, `cluster.stargateSelfRestartS` | L3 |
| Q11 | CVM boot, host reboot, Cassandra rejoin | 180 s (≤ 420 s `svm_reboot_timeout`), 300 s, rejoin after 30 min stable (`inferred`, KB-1256) | `cluster.cvmBootS`, `hostRebootS`, `cassandraRejoinStableS` | L7 |
| Q12 | SMART check, replica ack, remote Stargate down | SMART short test 120 s (`assumption`); replica ack 2 s for a live peer; a silently dead remote Stargate takes 20 s to detect (`inferred`), a clean stop ≈ 1 s | `hci.diskSmartCheckS`, `replicaAckTimeoutS`, `stargateDownDetectS` | needs an HCI lab |
| Q13 | FA controller reboot during upgrade | 300 s (`assumption`); a rebooting controller closes its TCP connections, so its paths drop at once, and in-flight IO waits CQT | `flasharray.controllerRebootS` | L6 |

**Still needs a portal login:** several new citations are Nutanix KBs read by title (their notes say "KB text not yet confirmed on the portal"). Confirming them would move the rebuild start delay, the 20 s Stargate-down detection and the 30 min rejoin to `verified`.

**Owner decisions made from evidence (flip if the lab disagrees):** HCI total partition self-terminates VMs (SPEC §14 #1); HCI reads stall on a minority node; T1 ZK seats move only after 300 s, so losing two seat holders costs about 5 minutes of cluster services; Hades maintenance on storage error is on by default (topology option `hades-maintenance-on-storage-error`).

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
