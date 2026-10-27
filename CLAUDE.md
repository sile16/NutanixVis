# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

Phase 0 (scaffold + contracts) is done; see `docs/SPEC.md` §13 for the parallel workstreams.

## Commands

pnpm is pinned via `packageManager` (pnpm 12). If `pnpm` isn't on PATH, use `npx -y pnpm@12.15.0 <cmd>`.

- `pnpm install`: install deps
- `pnpm dev`: Vite dev server (served under `/NutanixVis/`)
- `pnpm build` / `pnpm preview`: production build and a local preview of it
- `pnpm test`: all Vitest unit, contract and architecture tests. For a single file: `pnpm vitest run tests/contracts.test.ts`. For a single test: `pnpm vitest run -t "rejects duplicate"`
- `pnpm test:watch`: Vitest in watch mode
- `pnpm typecheck`: `tsc --noEmit` (TypeScript 7 native compiler)
- `pnpm lint` / `pnpm fix`: Biome lint and format check, or auto-fix. Markdown and `docs/` are excluded.
- `pnpm e2e`: Playwright smoke tests. Run `pnpm exec playwright install chromium` once first.
- `pnpm check:public`: fails if tracked files reference internal sources or vendor documents
- `pnpm verify`: check:public, lint, typecheck, test and build, all in sequence (`pnpm ci` is a pnpm built-in, so it is not ours)

## Contracts (integrator-owned; streams request changes, they don't edit these)

- `src/engine/types.ts`: Device hooks, Message/Trace/Event, Snapshot, actions, Simulation facade
- `src/topologies/schema.ts`: Zod topology schema and `defineTopology`
- `src/domain/versions/profile.ts`: version matrix and behavior Profile types
- `src/scenarios/define.ts`: scenario format and `defineScenario`
- `src/fixtures/snapshots/*`: typed fixture snapshots for UI work without the engine
- `tests/architecture.test.ts` enforces the layer boundaries (SPEC §4)

`src/loader/` wires topology + versions (+ domain devices) into an engine `Simulation` (`loadSimulation`). Until domain models land, non-network devices are `StaticDevice` placeholders.

**The project spec is `docs/SPEC.md`.** Read it before implementing. It covers the stack, layout, engine time model, domain models, scenario format and milestones. Cited vendor behavior and timer tables are in `docs/research/`. The repo and site are **public**. Every citation must be a publicly reachable source. `docs/internal/` holds notes from internal Everpure sources and is git-ignored: never let its values, links or wording into tracked files, code or UI. Where only internal data exists, use a labeled `assumption` (SPEC §2). `NutanixDocs/` and `EverpureDocs/` are local copies of vendor PDFs, git-ignored because they are copyrighted. Cite them by their public portal title and URL. Model **current-release behavior only**, with no historical explanations.

## Goal

An interactive failure-scenario simulator for **Nutanix**. Topology families (SPEC §1.1):

1. Nutanix compute (AHV) using an **external Everpure (formerly Pure Storage) FlashArray** over NVMe/TCP. ESXi is out of scope (owner decision, 2026-10-27).
2. **Nutanix HCI** (storage on the Nutanix nodes themselves).
3. **HCI with dedicated compute-only and storage-only nodes**, plus a single-NIC **T1-lab** mirror of the test drive.

The point is to let users inject failures (links, switches, controllers, hosts, nodes) and watch what happens. Behavior must be **accurate to the real products**. When you model a timeout, failover rule, or quorum behavior, cite the vendor doc or KB it comes from in a comment or in a docs file.

## Reference project (guide, not template)

`../ActiveClusterVis` (github: sile16/ActiveClusterVis) is a similar simulator for Pure ActiveCluster + VMware. It is plain-JS with no build step, Cytoscape.js 3.17 from a CDN, and global classes loaded via `<script>` tags. The owner wants this project to be cleaner, better branded, and more accurate. Take its ideas, not its code structure. We are free to swap frameworks and tooling (e.g. TypeScript, a bundler, a modern graph/rendering library).

Ideas worth keeping from it:

- **Device tree with a discrete-time model.** `NetworkDevice` / `NetworkGroup` form a hierarchy (`Site` → arrays/hosts/switches → ports/controllers). Time advances in _steps_, not wall-clock. Each step runs `preStep` → `step` → `postStep` from the root, so all devices see a consistent snapshot. Timers (resync delay, mediator delay, APD/PDL delay) are counted in steps and mirror _relative_ real-world timeouts.
- **Auto-step toggle.** Some scenarios (e.g. several simultaneous failures) only make sense if the user can apply several actions before time advances. Keep a manual-step mode.
- **Packets over simulated links.** Controllers and VMs emit packets (login, path discovery, IO, heartbeats, mediation) that traverse ports, switches, and connections; success or failure of delivery drives state. Link animation (colored balls on edges) reflects real traffic and is colored by type, with hover detail.
- **Action dropdown applied to a node or edge.** Actions irrelevant to a device are ignored. "Build-up" buttons (add WAN cables, add replication, add host entries) let users configure a topology incrementally, including _misconfigured_ setups.
- **Scenario coverage as tests.** Its README lists scenarios (pre-election, failover preference, uniform vs non-uniform, latency thresholds, split-brain). Its Todo notes the lack of unit tests, so encode scenarios as automated tests here from the start.

Known weaknesses of the reference to avoid:

- Simulation logic is tangled with Cytoscape rendering (`cvis.js` reaches into `edge._private.rscratch`). Keep the **simulation engine UI-agnostic and runnable headless** (e.g. in Node/Vitest) with the visualization layer only reading state.
- Globals (`globalAllConnections`, global `cy`), no modules, no tests, hardcoded node positions exported by hand from devtools, and the need to launch Chrome with `--allow-file-access-from-files` to run locally. Use ES modules and a dev server.

## Architecture principles to preserve

- Engine (topology + state machines + step scheduler) is separate from the renderer and from scenario definitions.
- Nutanix-specific behavior (CVM/Stargate/Cassandra/Zeus quorum, Curator, replication factor, data locality, AHV HA, host/CVM failure paths) and Pure FlashArray behavior (controller failover, host connectivity FC/iSCSI/NVMe-oF paths, ALUA, ActiveCluster if in scope) should be modeled in separate modules that plug into the shared device/network primitives.
- Topologies should be declarative data (devices, links, layout positions) so new scenarios do not require engine changes.
