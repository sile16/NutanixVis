/**
 * Cluster-wide extent-store state shared by every CVM's HCI backend: extent groups and their
 * replicas, replica availability, Curator rebuild and cleanup, capacity, and derived status.
 *
 * Model (SPEC §6.3):
 * - Each vDisk is E extent groups (`profile.hci.extentGroupsPerVdisk`), each with RF replicas
 *   on distinct CVM nodes; the first on the writing Stargate's node (Bible 4g data locality).
 * - A replica is `ok` (complete), `behind` (missed writes while unreachable; those writes are
 *   held by the RF Oplog copies on the nodes that acked them, Bible 4g), `filling` (a substitute
 *   or Curator copy still being populated) or `stale` (dropped from metadata after Curator
 *   restored RF elsewhere; garbage until the next Curator scan removes it).
 * - A replica is available when its CVM's Stargate is serving, the cluster has not declared that
 *   Stargate down, and its disk is online.
 * - Stargate-down detection (KB "IO freeze in UVMs is expected when CVM on different node
 *   shutdown or Stargate on different node crashes", `inferred`): a silent peer (node power
 *   loss, hang, network isolation) is declared down when its Zookeeper session expires,
 *   `hci.stargateDownDetectS` after it went silent; a cleanly stopped Stargate closes its session,
 *   so it is declared down after `hci.stargateStopDetectS`. Until then writing Stargates still
 *   target its replicas, so writes that need one stall. The rebuild clock starts at the
 *   declaration.
 * - An extent group is reachable if an `ok` replica is available, or a `behind` one is available
 *   together with another available copy holding the missed writes (`inferred`).
 *
 * Learns cluster state only through `ClusterView` (contract) and its own disk devices.
 */
import { asEngineContext } from '../../../engine/context';
import type { DeviceId, ViewField } from '../../../engine/types';
import type { ClusterView, Ctx } from '../../contracts';
import type { Profile } from '../../versions/profile';
import { STARGATE_PORT } from './assumptions';
import { cmp, type DataNode, type HciLayout } from './layout';
import { MSG, type RebuildPayload } from './messages';
import { type BlockAwareness, blockAwareness, placeReplicas } from './placement';

export type ReplicaState = 'ok' | 'behind' | 'filling' | 'stale';

export interface Replica {
  readonly node: DeviceId;
  readonly disk: DeviceId;
  state: ReplicaState;
  /** GiB copied so far while `filling`. */
  filledGiB: number;
}

export interface ExtentGroup {
  readonly id: string;
  readonly vdisk: string;
  /** Global ordinal: rotation key for placement. */
  readonly ordinal: number;
  readonly home: DeviceId;
  replicas: Replica[];
}

/** What the store needs from a disk device. */
export interface DiskHandle {
  readonly id: DeviceId;
  readonly node: DeviceId;
  readonly capacityTiB: number;
  /** Online and its host up: Stargate can read and write it. */
  serving(): boolean;
  /** Event id of the latest `disk.offline`, for causal chains. */
  lastOfflineEvent(): string | undefined;
}

export type Resiliency = 'OK' | 'Rebuilding' | 'Critical';

type PairStatus = 'ok' | 'dropped' | 'unknown';

/** A CVM the cluster is losing: since when, and how long until it is declared down. */
interface Suspect {
  readonly since: number;
  readonly detectS: number;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export class HciStore {
  readonly rf: number;
  readonly ft: number;
  readonly blockAwareness: BlockAwareness;
  private cluster: ClusterView | undefined;
  private readonly nodes: ReadonlyMap<DeviceId, DataNode>;
  private readonly nodeIds: readonly DeviceId[];
  private readonly disks = new Map<DeviceId, DiskHandle>();
  private readonly egs: ExtentGroup[] = [];
  private readonly byVdisk = new Map<string, ExtentGroup[]>();
  private readonly cursor = new Map<string, number>();
  private usedPct: number;

  // Curator state.
  private lastAdvance = -1;
  /** Unavailable replica locations already seen (`cvm:<id>` / `disk:<id>`) → first seen. */
  private readonly lost = new Map<string, number>();
  private readonly announced = new Set<string>();
  private rebuildActive = false;
  private stalled = false;
  private lastPairs = new Map<string, string>();
  /** `hci-rebuild` frames acked by their target this tick (by message id). */
  private readonly rebuildAcks = new Set<string>();
  private wasAvailable = true;
  /** CVMs that are not serving (or are outside the ZK quorum side), by when that started. */
  private readonly suspects = new Map<DeviceId, Suspect>();
  private lastObserve = -1;
  private capacityLevel: 'ok' | 'warn' | 'read-only' = 'ok';

  constructor(
    layout: HciLayout,
    readonly profile: Profile,
  ) {
    this.rf = layout.rf;
    this.ft = layout.rf - 1;
    this.nodes = new Map(layout.nodes.map((n) => [n.cvm, n]));
    this.nodeIds = layout.nodes.map((n) => n.cvm);
    this.blockAwareness = blockAwareness(
      layout.nodes.map((n) => n.block),
      this.ft,
    );
    this.usedPct = this.profile.hci.initialUsedCapacityPct.value;
    for (const n of layout.nodes) {
      for (const d of n.disks) {
        this.disks.set(d.id, {
          id: d.id,
          node: n.cvm,
          capacityTiB: d.capacityTiB,
          serving: () => true,
          lastOfflineEvent: () => undefined,
        });
      }
    }
    // Data written before t=0: placed with every node and disk up.
    for (const v of layout.vdisks) this.ensureVdisk(v.id, v.home);
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  attach(cluster: ClusterView): void {
    this.cluster ??= cluster;
  }

  registerDisk(handle: DiskHandle): void {
    this.disks.set(handle.id, handle);
  }

  /** Sim time of the latest Curator pass (0 before the first tick). */
  now(): number {
    return Math.max(0, this.lastAdvance);
  }

  setUsedCapacityPct(pct: number): void {
    this.usedPct = Math.min(100, Math.max(0, pct));
  }

  /** The target CVM confirmed a Curator copy frame (it is serving and reachable). */
  noteRebuildAck(msgId: string): void {
    this.rebuildAcks.add(msgId);
  }

  // ── Availability ──────────────────────────────────────────────────────────

  /** The CVM's Stargate is actually serving (it answers replica and rebuild frames). */
  nodeServing(cvm: DeviceId): boolean {
    const c = this.cluster;
    if (!this.nodes.has(cvm)) return false;
    return c === undefined || (c.isCvmUp(cvm) && c.isStargateUp(cvm));
  }

  /**
   * Track which Stargates the cluster is losing, once per tick (see header). A CVM that is down
   * is silent; one that runs with Stargate stopped is a clean stop; one outside the quorum side
   * (while a side has quorum) is isolated, hence silent.
   */
  observe(now: number): void {
    if (this.lastObserve === now) return;
    this.lastObserve = now;
    const c = this.cluster;
    if (c === undefined) return;
    const H = this.profile.hci;
    for (const n of this.nodeIds) {
      let detectS: number | undefined;
      if (!c.isCvmUp(n)) detectS = H.stargateDownDetectS.value;
      else if (!c.isStargateUp(n)) detectS = H.stargateStopDetectS.value;
      else if (c.zkQuorum() && c.inQuorum?.(n) === false) detectS = H.stargateDownDetectS.value;
      if (detectS === undefined) this.suspects.delete(n);
      else if (!this.suspects.has(n)) this.suspects.set(n, { since: now, detectS });
    }
  }

  /** The cluster has declared this CVM's Stargate down (its ZK session is gone). */
  nodeDown(cvm: DeviceId): boolean {
    const s = this.suspects.get(cvm);
    return s !== undefined && this.lastObserve - s.since >= s.detectS;
  }

  /** The CVM went silent but is not declared down yet: writes that need it wait. */
  awaitingDetection(cvm: DeviceId): boolean {
    return this.suspects.has(cvm) && !this.nodeDown(cvm);
  }

  /** Serving and not declared down: usable as a replica holder, source or target. */
  nodeUp(cvm: DeviceId): boolean {
    return this.nodeServing(cvm) && !this.nodeDown(cvm);
  }

  diskServing(id: DeviceId): boolean {
    return this.disks.get(id)?.serving() ?? false;
  }

  available(r: Replica): boolean {
    return this.nodeUp(r.node) && this.diskServing(r.disk);
  }

  /**
   * A writing Stargate still targets this replica: its node is not declared down and, if it is
   * up, its disk is online (a silent node's disks are unknown to the writer).
   */
  private writable(r: Replica): boolean {
    if (this.nodeDown(r.node)) return false;
    return !this.nodeServing(r.node) || this.diskServing(r.disk);
  }

  metadataAvailable(): boolean {
    return this.cluster?.metadataAvailable() ?? true;
  }

  /** Curator needs ZK, metadata and at least one serving CVM. */
  curatorCanRun(): boolean {
    const c = this.cluster;
    if (c !== undefined && !(c.zkQuorum() && c.metadataAvailable())) return false;
    return this.nodeIds.some((n) => this.nodeUp(n));
  }

  /** Curator master: the lowest serving CVM (`assumption`: election order is not published). */
  curatorLeader(): DeviceId {
    return this.nodeIds.find((n) => this.nodeUp(n)) ?? this.nodeIds[0] ?? 'cluster';
  }

  /** Nodes that can take a new replica now. */
  candidates(): DeviceId[] {
    return this.nodeIds.filter((n) => this.nodeUp(n) && this.servingDisks(n).length > 0);
  }

  private servingDisks(node: DeviceId): DiskHandle[] {
    const n = this.nodes.get(node);
    if (!n) return [];
    return n.disks.map((d) => this.disks.get(d.id)).filter((d): d is DiskHandle => !!d?.serving());
  }

  /** Least-filled serving disk on `node` (by replica bytes / capacity), ties by id. */
  pickDisk(node: DeviceId): DeviceId | undefined {
    const load = this.diskLoad();
    let best: DiskHandle | undefined;
    let bestFill = Number.POSITIVE_INFINITY;
    for (const d of this.servingDisks(node)) {
      const fill = (load.get(d.id) ?? 0) / d.capacityTiB;
      if (fill < bestFill) {
        best = d;
        bestFill = fill;
      }
    }
    return best?.id;
  }

  private diskLoad(): Map<DeviceId, number> {
    const load = new Map<DeviceId, number>();
    for (const eg of this.egs) {
      for (const r of eg.replicas) load.set(r.disk, (load.get(r.disk) ?? 0) + 1);
    }
    return load;
  }

  blockOf = (node: DeviceId): string | undefined => this.nodes.get(node)?.block;

  // ── Extent groups ─────────────────────────────────────────────────────────

  /** Create a vDisk's extent groups if unknown; first replica on `home` (Bible 4g). */
  ensureVdisk(vdisk: string, home: DeviceId): readonly ExtentGroup[] {
    const have = this.byVdisk.get(vdisk);
    if (have) return have;
    const list: ExtentGroup[] = [];
    const cand = this.candidates();
    for (let i = 0; i < this.profile.hci.extentGroupsPerVdisk.value; i++) {
      const ordinal = this.egs.length;
      const nodes = placeReplicas({
        key: ordinal,
        ...(this.nodes.has(home) ? { first: home } : {}),
        count: this.rf,
        candidates: cand,
        exclude: new Set(),
        blockOf: this.blockOf,
        blockAware: this.blockAwareness === 'met',
      });
      const replicas: Replica[] = [];
      for (const node of nodes) {
        const disk = this.pickDiskFor(node, ordinal);
        if (disk !== undefined) replicas.push({ node, disk, state: 'ok', filledGiB: 0 });
      }
      const eg: ExtentGroup = { id: `${vdisk}.eg-${i}`, vdisk, ordinal, home, replicas };
      this.egs.push(eg);
      list.push(eg);
    }
    this.byVdisk.set(vdisk, list);
    return list;
  }

  /** Initial placement rotates disks by ordinal (cheap, balanced); later picks use fill. */
  private pickDiskFor(node: DeviceId, ordinal: number): DeviceId | undefined {
    if (this.cluster !== undefined) return this.pickDisk(node);
    const disks = this.servingDisks(node);
    return disks[ordinal % Math.max(disks.length, 1)]?.id;
  }

  /** Next extent group of a vDisk for an IO (round-robin per op, deterministic). */
  nextExtentGroup(vdisk: string, home: DeviceId, op: 'read' | 'write'): ExtentGroup | undefined {
    const list = this.ensureVdisk(vdisk, home);
    const key = `${vdisk}:${op}`;
    const i = this.cursor.get(key) ?? 0;
    this.cursor.set(key, i + 1);
    return list[i % Math.max(list.length, 1)];
  }

  extentGroups(): readonly ExtentGroup[] {
    return this.egs;
  }

  liveReplicas(eg: ExtentGroup): Replica[] {
    return eg.replicas.filter((r) => r.state === 'ok' && this.available(r));
  }

  private fillingReplicas(eg: ExtentGroup): Replica[] {
    return eg.replicas.filter((r) => r.state === 'filling' && this.available(r));
  }

  /** Some available copy can serve the whole extent group (see header). */
  reachable(eg: ExtentGroup): boolean {
    if (this.liveReplicas(eg).length > 0) return true;
    return this.catchUpReplicas(eg).length > 0;
  }

  /** Available `behind` replicas whose missed writes are on another available copy. */
  private catchUpReplicas(eg: ExtentGroup): Replica[] {
    const holders = eg.replicas.filter(
      (r) => (r.state === 'ok' || r.state === 'filling') && this.available(r),
    );
    if (holders.length === 0) return [];
    return eg.replicas.filter((r) => r.state === 'behind' && this.available(r));
  }

  isUnderReplicated(eg: ExtentGroup): boolean {
    return this.liveReplicas(eg).length < this.rf;
  }

  /**
   * Nodes a write must reach: every complete or filling replica the writer still believes in
   * (`writable`: a silent node not yet declared down is still targeted, so the write stalls until
   * it is), plus substitutes on other healthy nodes for the rest, so RF copies are always
   * written (Bible 4g, 4i).
   * `undefined` = the write cannot be placed now (no live copy, or too few healthy nodes): hang.
   */
  writePlan(
    eg: ExtentGroup,
    tried: ReadonlySet<DeviceId>,
    pinned: ReadonlyMap<DeviceId, DeviceId> = new Map(),
  ): { node: DeviceId; disk: DeviceId; substitute: boolean }[] | undefined {
    if (!this.reachable(eg)) return undefined;
    const targets = [...pinned].map(([node, disk]) => ({ node, disk, substitute: false }));
    for (const r of eg.replicas) {
      if (r.state === 'stale' || !this.writable(r) || tried.has(r.node) || pinned.has(r.node)) {
        continue;
      }
      targets.push({ node: r.node, disk: r.disk, substitute: false });
    }
    const need = this.rf - targets.length;
    if (need > 0) {
      const exclude = new Set([...tried, ...targets.map((t) => t.node)]);
      const extra = placeReplicas({
        key: eg.ordinal,
        count: need,
        candidates: this.candidates(),
        exclude,
        usedBlocks: this.blocksOf(targets.map((t) => t.node)),
        blockOf: this.blockOf,
        blockAware: this.blockAwareness === 'met',
      });
      for (const node of extra) {
        const disk = this.pickDisk(node);
        if (disk !== undefined) targets.push({ node, disk, substitute: true });
      }
    }
    return targets.length >= this.rf ? targets : undefined;
  }

  private blocksOf(nodes: readonly DeviceId[]): Set<string> {
    const s = new Set<string>();
    for (const n of nodes) {
      const b = this.blockOf(n);
      if (b !== undefined) s.add(b);
    }
    return s;
  }

  /**
   * A write committed on `acked` (node → disk). Copies that missed it fall `behind` (a partial
   * Curator copy that missed it is discarded); substitutes become `filling` until Curator copies
   * the rest of the extent group, so the group stays under-replicated until rebuilt (Bible 4i).
   */
  commitWrite(eg: ExtentGroup, acked: ReadonlyMap<DeviceId, DeviceId>): void {
    for (const r of eg.replicas) {
      if (r.state === 'stale' || acked.get(r.node) === r.disk) continue;
      r.state = r.state === 'filling' ? 'stale' : 'behind';
    }
    for (const [node, disk] of acked) {
      if (eg.replicas.some((r) => r.node === node && r.disk === disk && r.state !== 'stale')) {
        continue;
      }
      const live = eg.replicas.filter(
        (r) => (r.state === 'ok' || r.state === 'filling') && this.available(r),
      ).length;
      eg.replicas.push({
        node,
        disk,
        state: live < this.rf ? 'filling' : 'stale',
        filledGiB: 0,
      });
    }
  }

  /** Replica to read from: local if live, else a live remote one, else a catching-up one. */
  readSource(
    eg: ExtentGroup,
    servedBy: DeviceId,
    tried: ReadonlySet<DeviceId>,
  ): Replica | undefined {
    const pick = (rs: Replica[]) => {
      const ok = rs.filter((r) => !tried.has(r.node));
      return ok.find((r) => r.node === servedBy) ?? ok[0];
    };
    return pick(this.liveReplicas(eg)) ?? pick(this.catchUpReplicas(eg));
  }

  // ── Capacity ──────────────────────────────────────────────────────────────

  private rawTiB(onlyServing: boolean): number {
    let t = 0;
    for (const d of this.disks.values()) {
      if (!onlyServing || (d.serving() && this.nodeServing(d.node))) t += d.capacityTiB;
    }
    return t;
  }

  private physicalTiB(): number {
    return (this.usedPct / 100) * this.rawTiB(false);
  }

  /** One replica's modeled size: logical data / extent groups. */
  replicaGiB(): number {
    const logical = this.physicalTiB() / this.rf;
    return (logical * 1024) / Math.max(this.egs.length, 1);
  }

  /** Used physical capacity as % of the raw capacity currently serving. */
  capacityPct(): number {
    const raw = this.rawTiB(true);
    return raw === 0 ? 100 : (this.physicalTiB() / raw) * 100;
  }

  /** % of resilient capacity: raw minus FT × the largest node (Prism's warning basis, Bible 4i). */
  resilientCapacityPct(): number {
    let largest = 0;
    for (const n of this.nodes.values()) {
      largest = Math.max(
        largest,
        n.disks.reduce((s, d) => s + d.capacityTiB, 0),
      );
    }
    const resilient = this.rawTiB(false) - this.ft * largest;
    return resilient <= 0 ? 100 : (this.physicalTiB() / resilient) * 100;
  }

  /** Stargate goes read-only at `hci.readOnlyCapacityPct` (Bible 4i). */
  readOnly(): boolean {
    return this.capacityPct() >= this.profile.hci.readOnlyCapacityPct.value;
  }

  // ── Curator (once per tick, from whichever data-path device ticks first) ──

  advance(ctx: Ctx): void {
    if (this.lastAdvance === ctx.now) return;
    this.lastAdvance = ctx.now;
    this.observe(ctx.now);
    this.dropUnneededFills();
    this.detectFailures(ctx);
    this.rebuild(ctx);
    this.scan(ctx);
    this.availabilityEvents(ctx);
    this.capacityEvents(ctx);
  }

  /** A copy is no longer needed once RF live replicas are back (e.g. the node returned). */
  private dropUnneededFills(): void {
    for (const eg of this.egs) {
      const live = this.liveReplicas(eg).length;
      eg.replicas = eg.replicas.filter(
        (r) => r.state !== 'filling' || (live < this.rf && this.available(r)),
      );
    }
  }

  /**
   * Where an unavailable replica was lost: its disk (node up), or its CVM once the cluster has
   * declared that Stargate down. `undefined` while the node is silent but not yet declared down.
   */
  private lostKey(r: Replica): string | undefined {
    if (this.nodeUp(r.node)) return `disk:${r.disk}`;
    return this.nodeDown(r.node) ? `cvm:${r.node}` : undefined;
  }

  /**
   * Rebuild starts `hci.rebuildStartDelayS` after a location is lost: for a CVM, counted from
   * when its Stargate is declared down; for a disk, from when Stargate marks it offline (Bible
   * 4i; KBs "Delayed rebuild for planned maintenance events", "Slow data rebuild after failure
   * on clusters with Erasure Coding enabled").
   */
  private detectFailures(ctx: Ctx): void {
    const now = ctx.now;
    const seen = new Map<string, DeviceId>();
    for (const eg of this.egs) {
      for (const r of eg.replicas) {
        if ((r.state !== 'ok' && r.state !== 'behind') || this.available(r)) continue;
        const key = this.lostKey(r);
        if (key !== undefined) seen.set(key, r.node);
      }
    }
    for (const key of [...this.lost.keys()]) {
      if (!seen.has(key)) {
        this.lost.delete(key);
        this.announced.delete(key);
      }
    }
    for (const key of seen.keys()) if (!this.lost.has(key)) this.lost.set(key, now);

    if (!this.curatorCanRun()) return;
    const delay = this.profile.hci.rebuildStartDelayS.value;
    for (const [key, since] of [...this.lost].sort((a, b) => cmp(a[0], b[0]))) {
      if (this.announced.has(key) || now - since < delay) continue;
      this.announced.add(key);
      this.rebuildActive = true;
      const node = seen.get(key) ?? this.curatorLeader();
      const diskId = key.startsWith('disk:') ? key.slice(5) : undefined;
      const cause = diskId === undefined ? undefined : this.disks.get(diskId)?.lastOfflineEvent();
      ctx.emit({
        severity: 'warn',
        deviceId: node,
        code: 'curator.rebuild.start',
        text:
          diskId === undefined
            ? `Curator starts re-replicating the extent groups that had a copy on ${node}`
            : `Curator starts re-replicating the extent groups that had a copy on ${diskId}`,
        causeIds: cause === undefined ? [] : [cause],
        cite: this.profile.hci.rebuildStartDelayS.cite,
        confidence: this.profile.hci.rebuildStartDelayS.confidence,
      });
    }
  }

  /**
   * One Curator pass (Bible 4i):
   * 1. Catch-up: an available `behind` copy replays its missed writes from a copy that holds
   *    them and is `ok` again (`assumption`: modeled as one exchange, the delta being small).
   * 2. Rebuild: copy under-replicated extent groups at `rebuildGiBpsPerNode` × surviving nodes
   *    (`assumption`), fewest live copies first, onto new targets chosen by `placeReplicas`.
   *    A group waits until the rebuild for a location it lost has started (`detectFailures`).
   * A copy only progresses over a source → target pair whose last `hci-rebuild` frame the target
   * acked, so network faults or a dead target Stargate stall it.
   */
  private rebuild(ctx: Ctx): void {
    const ectx = asEngineContext(ctx);
    const pairStatus = (key: string): PairStatus => {
      const id = this.lastPairs.get(key);
      if (id === undefined) return 'unknown';
      if (this.rebuildAcks.has(id)) return 'ok';
      return ectx.trace(id)?.result === 'dropped' ? 'dropped' : 'unknown';
    };
    const sends = new Map<string, RebuildPayload>();
    /** Queue a frame on the best pair from `srcs` to `to`; returns true if that pair is good. */
    const use = (eg: ExtentGroup, srcs: readonly Replica[], to: DeviceId): boolean => {
      const pairs = srcs.map((r) => ({ from: r.node, key: `${r.node}>${to}` }));
      const good = pairs.find((x) => pairStatus(x.key) === 'ok');
      const pick = good ?? pairs.find((x) => pairStatus(x.key) === 'unknown') ?? pairs[0];
      if (pick) sends.set(pick.key, { eg: eg.id, from: pick.from, to });
      return good !== undefined;
    };

    const canRun = this.curatorCanRun();
    let progressed = false;
    let placeable = false;
    let short = false;
    let waiting = false;
    if (canRun) {
      for (const eg of this.egs) {
        const holders = eg.replicas.filter(
          (r) => (r.state === 'ok' || r.state === 'filling') && this.available(r),
        );
        for (const b of eg.replicas) {
          if (b.state !== 'behind' || !this.available(b) || holders.length === 0) continue;
          placeable = true;
          if (use(eg, holders, b.node)) {
            b.state = 'ok';
            progressed = true;
          }
        }
      }
    }

    const jobs = this.egs
      .filter((eg) => this.isUnderReplicated(eg) && this.liveReplicas(eg).length > 0)
      .sort(
        (a, b) =>
          this.liveReplicas(a).length - this.liveReplicas(b).length || a.ordinal - b.ordinal,
      );
    const cand = this.candidates();
    let budget = canRun ? this.profile.hci.rebuildGiBpsPerNode.value * cand.length : 0;
    const size = this.replicaGiB();
    for (const eg of canRun ? jobs : []) {
      if (!this.rebuildDue(eg)) {
        waiting = true;
        continue;
      }
      const live = this.liveReplicas(eg);
      const fills = this.fillingReplicas(eg);
      const need = this.rf - live.length - fills.length;
      if (need > 0) {
        const holders = [...live, ...fills].map((r) => r.node);
        const targets = placeReplicas({
          key: eg.ordinal,
          count: need,
          candidates: cand,
          exclude: new Set(holders),
          usedBlocks: this.blocksOf(holders),
          blockOf: this.blockOf,
          blockAware: this.blockAwareness === 'met',
        });
        for (const node of targets) {
          const disk = this.pickDisk(node);
          if (disk === undefined) continue;
          const r: Replica = { node, disk, state: 'filling', filledGiB: 0 };
          eg.replicas.push(r);
          fills.push(r);
        }
      }
      if (fills.length > 0) placeable = true;
      if (live.length + fills.length < this.rf) short = true;
      for (const f of fills) {
        // Every needed pair carries a frame each tick (data, or a probe), so reachability stays
        // current even for copies waiting on the budget.
        if (!use(eg, live, f.node) || budget <= 0) continue;
        const take = Math.min(budget, size - f.filledGiB);
        f.filledGiB += take;
        budget -= take;
        progressed = true;
        if (f.filledGiB >= size - 1e-9) this.completeCopy(eg, f);
      }
    }
    const under = this.underReplicated();
    // Critical rather than Rebuilding when RF cannot be restored with the nodes that remain.
    this.stalled = under > 0 && (!canRun || short || (!placeable && !progressed && !waiting));

    this.rebuildAcks.clear();
    const next = new Map<string, string>();
    const c = this.cluster;
    for (const [key, p] of [...sends].sort((a, b) => cmp(a[0], b[0]))) {
      if (c === undefined) break;
      const src = c.cvmDataEndpoint(p.from);
      const dst = c.cvmDataEndpoint(p.to);
      const id = ctx.send<RebuildPayload>({
        kind: MSG.rebuild,
        src,
        dst,
        size: 'large',
        flow: ectx.flow(src, dst, { proto: 'tcp', dstPort: STARGATE_PORT }),
        payload: p,
      });
      next.set(key, id);
    }
    this.lastPairs = next;
    this.finishIfDone(ctx, under);
  }

  /**
   * Curator copies a group once the rebuild for one of the locations it lost has started, or
   * right away when it is short for another reason (no lost location pending).
   */
  private rebuildDue(eg: ExtentGroup): boolean {
    let pending = false;
    for (const r of eg.replicas) {
      if ((r.state !== 'ok' && r.state !== 'behind') || this.available(r)) continue;
      const key = this.lostKey(r);
      if (key !== undefined && this.announced.has(key)) return true;
      pending = true;
    }
    return !pending;
  }

  /** A copy is complete; once RF copies are live, unavailable old copies leave the metadata. */
  private completeCopy(eg: ExtentGroup, f: Replica): void {
    f.state = 'ok';
    f.filledGiB = 0;
    if (this.liveReplicas(eg).length < this.rf) return;
    for (const r of eg.replicas) {
      if ((r.state === 'ok' || r.state === 'behind') && !this.available(r)) r.state = 'stale';
    }
  }

  private finishIfDone(ctx: Ctx, under: number): void {
    if (!this.rebuildActive || under > 0) return;
    this.rebuildActive = false;
    this.announced.clear();
    ctx.emit({
      severity: 'info',
      deviceId: this.curatorLeader(),
      code: 'curator.rebuild.complete',
      text: `Every extent group is back to RF${this.rf}`,
      causeIds: [],
      cite: ['ntnx-bible-4i'],
      confidence: 'verified',
    });
  }

  /** Extra copies are removed by a later Curator scan (`hci.curatorPartialScanS`, Bible 4i). */
  private scan(ctx: Ctx): void {
    const every = this.profile.hci.curatorPartialScanS.value;
    if (every <= 0 || ctx.now % every !== 0 || !this.curatorCanRun()) return;
    let removed = 0;
    for (const eg of this.egs) {
      const before = eg.replicas.length;
      eg.replicas = eg.replicas.filter((r) => r.state !== 'stale');
      removed += before - eg.replicas.length;
    }
    if (removed === 0) return;
    ctx.emit({
      severity: 'info',
      deviceId: this.curatorLeader(),
      code: 'curator.cleanup',
      text: `Curator partial scan removed ${removed} extra replica(s)`,
      causeIds: [],
      cite: ['ntnx-bible-4i', ...this.profile.hci.curatorPartialScanS.cite],
      confidence: this.profile.hci.curatorPartialScanS.confidence,
    });
  }

  private availabilityEvents(ctx: Ctx): void {
    const ok = this.dataAvailable();
    if (ok === this.wasAvailable) return;
    this.wasAvailable = ok;
    ctx.emit(
      ok
        ? {
            severity: 'info',
            deviceId: this.curatorLeader(),
            code: 'hci.data.available',
            text: 'Every extent group has a reachable replica again',
            causeIds: [],
            cite: ['ntnx-bible-4i'],
            confidence: 'inferred',
          }
        : {
            severity: 'critical',
            deviceId: this.curatorLeader(),
            code: 'hci.data.unavailable',
            text: `${this.unavailableCount()} extent group(s) have no reachable replica: IO to them hangs until a copy returns`,
            causeIds: [],
            cite: ['ntnx-bible-4i', 'ntnx-community-beyond-ft'],
            confidence: 'unverified',
          },
    );
  }

  private capacityEvents(ctx: Ctx): void {
    const level = this.readOnly()
      ? 'read-only'
      : this.resilientCapacityPct() > this.profile.hci.capacityWarnPct.value
        ? 'warn'
        : 'ok';
    if (level === this.capacityLevel) return;
    this.capacityLevel = level;
    const pct = round1(this.capacityPct());
    ctx.emit({
      severity: level === 'read-only' ? 'critical' : level === 'warn' ? 'warn' : 'info',
      deviceId: this.curatorLeader(),
      code: `hci.capacity.${level}`,
      text:
        level === 'read-only'
          ? `Storage ${pct}% full: Stargate is read-only`
          : level === 'warn'
            ? `Resilient capacity above ${this.profile.hci.capacityWarnPct.value}%`
            : `Storage ${pct}% full`,
      causeIds: [],
      cite: ['ntnx-bible-4i'],
      confidence: 'verified',
    });
  }

  // ── Derived status ────────────────────────────────────────────────────────

  dataAvailable(): boolean {
    return this.egs.every((eg) => this.reachable(eg));
  }

  private unavailableCount(): number {
    return this.egs.filter((eg) => !this.reachable(eg)).length;
  }

  underReplicated(): number {
    return this.egs.filter((eg) => this.isUnderReplicated(eg)).length;
  }

  /** Prism-style data resiliency: Rebuilding while Curator can restore RF, else Critical. */
  resiliency(): Resiliency {
    if (!this.dataAvailable()) return 'Critical';
    if (this.underReplicated() === 0) return 'OK';
    return this.curatorCanRun() && !this.stalled ? 'Rebuilding' : 'Critical';
  }

  /** Extra node failures the current replica state survives without data becoming unavailable. */
  dataNodeFailureTolerance(): number {
    let min = this.ft;
    for (const eg of this.egs) min = Math.min(min, this.liveReplicas(eg).length - 1);
    return Math.max(0, min);
  }

  /** GiB Curator still has to copy. */
  rebuildRemainingGiB(): number {
    const size = this.replicaGiB();
    let gib = 0;
    for (const eg of this.egs) {
      const live = this.liveReplicas(eg).length;
      if (live >= this.rf || live === 0) continue;
      const fills = this.fillingReplicas(eg);
      const done = fills.reduce((s, f) => s + f.filledGiB, 0);
      gib += (this.rf - live) * size - done;
    }
    return Math.max(0, gib);
  }

  replicasOn(node: DeviceId): number {
    let n = 0;
    for (const eg of this.egs)
      for (const r of eg.replicas) if (r.node === node && r.state === 'ok') n++;
    return n;
  }

  replicasOnDisk(disk: DeviceId): number {
    let n = 0;
    for (const eg of this.egs)
      for (const r of eg.replicas) if (r.disk === disk && r.state === 'ok') n++;
    return n;
  }

  /** Remove every replica on a disk (its data was wiped when an operator re-added it). */
  forgetDisk(disk: DeviceId): void {
    for (const eg of this.egs) eg.replicas = eg.replicas.filter((r) => r.disk !== disk);
  }

  derived(): Readonly<Record<string, ViewField>> {
    let garbage = 0;
    for (const eg of this.egs) for (const r of eg.replicas) if (r.state === 'stale') garbage++;
    return {
      resiliency: this.resiliency(),
      dataAvailable: this.dataAvailable(),
      underReplicated: this.underReplicated(),
      blockAwareness: this.blockAwareness,
      'hci.rf': this.rf,
      'hci.extentGroups': this.egs.length,
      'hci.unavailableExtentGroups': this.unavailableCount(),
      'hci.rebuildRemainingGiB': Math.round(this.rebuildRemainingGiB()),
      'hci.dataNodeFailureTolerance': this.dataNodeFailureTolerance(),
      'hci.capacityPct': round1(this.capacityPct()),
      'hci.resilientCapacityPct': round1(this.resilientCapacityPct()),
      'hci.readOnly': this.readOnly(),
      'hci.garbageReplicas': garbage,
      'hci.curatorLeader': this.curatorLeader(),
    };
  }
}
