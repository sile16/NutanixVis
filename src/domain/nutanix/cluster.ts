/**
 * Cluster-level state machines (SPEC §6.2, §6.3a, §6.4 "T1 compute cluster HA"):
 *
 * - **Zookeeper quorum.** CVMs that reach each other (ZK pings) form partitions. A partition has
 *   quorum if it holds a majority of the ZK ensemble (3 seats, 5 under FT2; profile
 *   `zkMembersFt1/Ft2`, KB-1587). HCI (T2/T3): seats are fixed on CVM-bearing nodes. T1: a seat
 *   is live only while its CVM reaches its service volumes on the array. A lost seat (an "active
 *   node" that failed) moves to an array-connected CVM on the partition with the most of them,
 *   if that partition keeps at least N − tolerance (N−2 / N−3 rule,
 *   `externalStorage.nodeFailureTolerance`), only after `cluster.serviceVolumeMigrationDelayS`
 *   (PowerStore deployment guide 7.6 "after a 5-minute delay"; `inferred` for FlashArray).
 * - **Cluster services / Prism Element.** Down once ZK quorum or metadata has been unavailable
 *   for `cluster.zkSessionTimeoutS`; IO effects of the loss are immediate. Prism Central then
 *   shows A200000 "Cluster Connectivity Status".
 * - **Cassandra ring.** Metadata RF 2·FT+1 over ring neighbours (block-aware order); a range is
 *   available with a Paxos majority. A node down `cluster.cassandraRingDetachS` is detached, and
 *   re-added once stable (Bible 4i, KB-1256). T1 metadata is on the array: available with quorum.
 * - **Acropolis leader.** Lowest node id initially (SPEC §14 #8); when its CVM is lost or leaves
 *   the quorum side a new one is elected `ahvHa.leaderReelectionS` later (Bible 5b).
 * - **AHV HA** (Bible 5b; AHV Admin Guide 11.2). T = first missed heartbeat. T+`timeoutStartS`
 *   the `disconnectTimeoutS` timer starts (host `disconnected`); T+`fenceAtS` Stargates fence the
 *   host; VMs restart by T+`restartByS` on hosts with capacity. A new leader inherits T from
 *   Zeus, so the timeline is unchanged when the leader host itself fails. Never run a VM twice:
 *   a restart waits until the old process is gone.
 */

import type { Device, DeviceView, TimerHandle, TimerOptions, ViewField } from '../../engine/types';
import type { KnownCitationId } from '../citations';
import type { Ctx } from '../contracts';
import type { Profile } from '../versions/profile';
import { nodeOrder } from './facts';
import type { Registry } from './registry';

export const CLUSTER_DEVICE_ID = 'cluster';

type HaStatus = 'OK' | 'Healing' | 'Critical';

export class ClusterDevice implements Device<Profile> {
  readonly id = CLUSTER_DEVICE_ID;
  readonly kind = 'nutanix-cluster';
  readonly label = 'Nutanix cluster';
  private haStatus: HaStatus = 'OK';
  private services: 'up' | 'down' = 'up';
  /** First tick quorum or metadata was missing (ZK session-timeout clock). */
  private servicesLostAt: number | null = null;
  private ftShort = false;
  private advised = false;
  /** A ZK seat is not live (alert A111009 raised for the current episode). */
  private zkNotActive = false;
  /** Running CVMs reported unreachable from the quorum side (A1001), per episode. */
  private readonly unreachable = new Set<string>();
  /** VMs whose HA restart found no host (A1145), per episode. */
  private readonly restartFailed = new Set<string>();
  private haShort = false;
  private readonly wakes = new Map<string, TimerHandle>();
  /** DND per CVM: end of its scoring window, and since when a Degraded node has been healthy. */
  private readonly dndWindowEnd = new Map<string, number>();
  private readonly dndHealthySince = new Map<string, number | null>();
  /** CVMs still cut off when their scoring window ended: dead, not scored again until healthy. */
  private readonly dndDead = new Set<string>();
  private derivedCache: Record<string, ViewField> = {};

  constructor(private readonly reg: Registry) {
    this.derivedCache = this.computeDerived();
  }

  preTick(ctx: Ctx): void {
    this.reg.now = ctx.now;
  }

  tick(ctx: Ctx): void {
    this.reg.now = ctx.now;
    this.evalZk(ctx);
    this.evalDnd(ctx);
    this.evalRing(ctx);
    this.evalLeader(ctx);
    this.evalHa(ctx);
    this.powerOns(ctx);
  }

  /** `power-on` of a VM: on its last host if it can run VMs, else the least loaded host. */
  private powerOns(ctx: Ctx): void {
    const load = this.load();
    for (const id of [...this.reg.powerOnRequests].sort(nodeOrder)) {
      const vm = this.reg.vms.get(id);
      if (!vm || vm.hasLiveInstance()) continue;
      const home = vm.homeHost;
      const target = this.eligible(home) ? home : this.pickHost(load);
      if (target === null) continue;
      this.login(vm.vdisks, target);
      vm.startOn(target, ctx, this.reg.causes.get(id) ?? [], false);
    }
    this.reg.powerOnRequests.clear();
  }

  postTick(ctx: Ctx): void {
    this.advisories(ctx);
    const T = ctx.profile.cluster.zkSessionTimeoutS;
    const ok = this.reg.quorumSide !== null && this.reg.metaAvailable;
    if (ok) this.servicesLostAt = null;
    else this.servicesLostAt ??= ctx.now;
    const lostAt = this.servicesLostAt;
    if (lostAt !== null) this.wake(ctx, 'zk session timeout', lostAt + T.value, T);
    const services = lostAt === null || ctx.now - lostAt < T.value ? 'up' : 'down';
    if (services !== this.services) {
      this.services = services;
      const base: readonly KnownCitationId[] = this.reg.facts.externalStorage
        ? ['ntnx-ncp-everpure-deploy-7.6']
        : ['ntnx-kb-1587', 'ntnx-bible-4i'];
      ctx.emit({
        severity: services === 'down' ? 'critical' : 'info',
        code: `cluster.services.${services}`,
        text:
          services === 'down'
            ? `Cluster services are down: no Zookeeper quorum or metadata for ${T.value} s (ZK session timeout). Prism Element is unreachable; Prism Central raises A200000 "Cluster Connectivity Status"`
            : 'Cluster services are back up; Prism Element is reachable again',
        causeIds: [],
        cite: [...base, ...T.cite, 'ntnx-pc-alerts-7.6-cluster', 'ntnx-community-cluster-shutdown'],
        confidence: 'inferred',
      });
    }
    this.haStatus = this.computeHaStatus();
    this.haResources(ctx);
    this.derivedCache = this.computeDerived();
  }

  derived(): Readonly<Record<string, ViewField>> {
    return this.derivedCache;
  }

  view(): DeviceView {
    const d = this.derivedCache;
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      status:
        d.clusterServices === 'down' ? 'failed' : this.haStatus === 'OK' ? 'healthy' : 'degraded',
      badges: [],
      fields: { ...d },
    };
  }

  // ── Zookeeper ───────────────────────────────────────────────────────────

  private evalZk(ctx: Ctx): void {
    const reg = this.reg;
    // CVMs whose services started this tick have not pinged ZK yet: judged from the next tick.
    const running = reg.facts.cvms
      .map((c) => c.id)
      .filter((c) => reg.cvmRunning(c) && (reg.cvms.get(c)?.runningSince ?? 0) < ctx.now);
    // Union-find over "answered my ZK ping this tick" (either direction).
    const parent = new Map(running.map((c) => [c, c] as const));
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r) ?? r;
      parent.set(x, r);
      return r;
    };
    for (const c of running) {
      for (const p of reg.cvms.get(c)?.zk.heard ?? []) {
        if (!parent.has(p)) continue;
        const a = find(c);
        const b = find(p);
        if (a !== b) parent.set(nodeOrder(a, b) < 0 ? b : a, nodeOrder(a, b) < 0 ? a : b);
      }
    }
    const comps = new Map<string, string[]>();
    for (const c of running) comps.set(find(c), [...(comps.get(find(c)) ?? []), c]);
    reg.partitionOf.clear();
    for (const members of comps.values()) {
      const id = [...members].sort(nodeOrder)[0] ?? '';
      for (const c of members) reg.partitionOf.set(c, id);
    }

    if (reg.facts.externalStorage) {
      const need = reg.facts.cvms.length - reg.externalTolerance();
      let best: string[] | null = null;
      let bestN = 0;
      for (const members of [...comps.values()].sort((a, b) => nodeOrder(a[0] ?? '', b[0] ?? ''))) {
        const n = members.filter((c) => reg.cvmCapable(c)).length;
        if (n > bestN) {
          best = members;
          bestN = n;
        }
      }
      this.migrateSeats(ctx, best !== null && bestN >= need ? best : null);
    }
    // A live seat: its CVM runs (T1: and reaches its service volumes on the array).
    const m = reg.zkMembers.size;
    let side: string[] | null = null;
    for (const members of comps.values()) {
      const live = members.filter((c) => reg.zkMembers.has(c) && reg.cvmCapable(c)).length;
      if (live > m / 2) side = members;
    }
    const had = reg.quorumSide !== null;
    reg.quorumSide = side ? new Set(side) : null;
    if (had !== (side !== null)) {
      const z = ctx.profile.cluster.zkMembersFt1;
      ctx.emit({
        severity: side ? 'info' : 'critical',
        code: side ? 'zk.quorum.restored' : 'zk.quorum.lost',
        text: side ? 'Zookeeper quorum restored' : 'No partition holds a Zookeeper majority',
        causeIds: [],
        cite: z.cite,
        confidence: reg.facts.externalStorage ? 'inferred' : z.confidence,
      });
    }

    // ZK leader: keep it while it is a live seat on the quorum side.
    const prev = reg.zkLeader;
    const liveSeats = side
      ? side.filter((c) => reg.zkMembers.has(c) && reg.cvmCapable(c)).sort(nodeOrder)
      : [];
    if (prev === null || !liveSeats.includes(prev)) reg.zkLeader = liveSeats[0] ?? null;
    if (reg.zkLeader !== prev && reg.zkLeader !== null) {
      ctx.emit({
        severity: 'info',
        deviceId: reg.zkLeader,
        code: 'zk.leader.elected',
        text: `${reg.zkLeader} is the Zookeeper leader`,
        causeIds: [],
        cite: ['ntnx-community-cvm-components'],
        confidence: 'unverified',
      });
    }
    const zkSlack = liveSeats.length - (Math.floor(reg.zkMembers.size / 2) + 1);
    reg.serviceTolerance = side ? Math.max(0, zkSlack) : 0;
    reg.zkTolerance = reg.serviceTolerance;
    this.zkAlerts(ctx, side);
  }

  /**
   * T1 service-volume migration: a seat whose CVM is lost (down, in Hades maintenance, off the
   * array, or outside `target`) moves to an inactive array-connected CVM of `target` once it has
   * been lost for `cluster.serviceVolumeMigrationDelayS`. With no target (no partition keeps
   * N − tolerance array-connected CVMs) seats stay where they are. The upgrade exception
   * ("During an upgrade, the cluster does not migrate cluster services") has no trigger here:
   * the model simulates no AOS/AHV upgrade.
   */
  private migrateSeats(ctx: Ctx, target: readonly string[] | null): void {
    const reg = this.reg;
    const D = ctx.profile.cluster.serviceVolumeMigrationDelayS;
    const seats = [...reg.zkMembers].sort(nodeOrder);
    for (const s of seats) {
      const lost = !reg.cvmCapable(s) || (target !== null && !target.includes(s));
      if (!lost) reg.seatLostSince.delete(s);
      else if (!reg.seatLostSince.has(s)) reg.seatLostSince.set(s, ctx.now);
    }
    if (target === null) return;
    const next = new Set(reg.zkMembers);
    for (const s of seats) {
      const since = reg.seatLostSince.get(s);
      if (since === undefined) continue;
      this.wake(ctx, `${s} service-volume migration`, since + D.value, D);
      if (ctx.now - since < D.value) continue;
      const to = target.filter((c) => reg.cvmCapable(c) && !next.has(c)).sort(nodeOrder)[0];
      if (to === undefined) continue;
      next.delete(s);
      next.add(to);
      reg.seatLostSince.delete(s);
      ctx.emit({
        severity: 'warn',
        deviceId: to,
        code: 'zk.seat.migrated',
        text: `Zookeeper/Cassandra service volumes of ${s} mounted on ${to} after ${D.value} s`,
        causeIds: [],
        cite: [...D.cite],
        confidence: D.confidence,
      });
    }
    reg.zkMembers = next;
  }

  /** A111009 (a ZK seat is not live) and A1001 (a running CVM the quorum side cannot reach). */
  private zkAlerts(ctx: Ctx, side: readonly string[] | null): void {
    const reg = this.reg;
    if (side === null) {
      // Prism Element's own alerting is a cluster service: nothing new is raised without quorum.
      this.unreachable.clear();
      return;
    }
    const down = [...reg.zkMembers]
      .filter((c) => !(reg.cvmCapable(c) && side.includes(c)))
      .sort(nodeOrder);
    if (down.length > 0 && !this.zkNotActive) {
      ctx.emit({
        severity: 'warn',
        ...(down[0] === undefined ? {} : { deviceId: down[0] }),
        code: 'zk.not-active',
        text: `Zookeeper is not active on all CVMs (${down.join(', ')}). Prism alert A111009 "Zookeeper Not Active on All CVMs": cluster resiliency is affected`,
        causeIds: [],
        cite: ['ntnx-pe-alerts-7.0-cluster', 'ntnx-kb-1587'],
        confidence: 'inferred',
      });
    }
    this.zkNotActive = down.length > 0;
    for (const c of reg.facts.cvms.map((x) => x.id)) {
      // Judged once it has pinged (in a partition): a CVM that just started is not yet.
      if (!(reg.partitionOf.has(c) && !side.includes(c))) {
        this.unreachable.delete(c);
        continue;
      }
      if (this.unreachable.has(c)) continue;
      this.unreachable.add(c);
      ctx.emit({
        severity: 'warn',
        deviceId: c,
        code: 'cluster.cvm.unreachable',
        text: `${c} is not reachable from the CVMs holding quorum. Prism alert A1001 "CVM Connectivity Failure"`,
        causeIds: [],
        cite: ['ntnx-pe-alerts-7.0-cvm'],
        confidence: 'inferred',
      });
    }
  }

  // ── Degraded Node Detection ─────────────────────────────────────────────

  /**
   * DND (Nutanix community "Degraded Node Detection"; `dnd.*`): peers score each CVM's
   * responsiveness. A running CVM the quorum side cannot reach starts a scoring window; if at its
   * end the CVM answers again (it flapped or was partly unresponsive), it is marked Degraded: its
   * Cassandra goes to forwarding mode (metadata store disabled), so the ring and the cluster's
   * fault tolerance lose it, and an alert is raised. A CVM still cut off or down at the end is
   * treated as dead, not degraded (isolation and HA handle it), and is not scored again until it
   * is healthy again. Cleared after `autoResolveHealthyS` of health, or when an operator marks it
   * fixed (`cvm.mark-fixed`).
   */
  private evalDnd(ctx: Ctx): void {
    const reg = this.reg;
    const D = ctx.profile.dnd;
    const side = reg.quorumSide;
    for (const c of reg.facts.cvms.map((x) => x.id)) {
      const state = reg.dnd.get(c) ?? 'ok';
      if (!D.enabled.value) {
        reg.dnd.set(c, 'ok');
        continue;
      }
      const running = reg.cvmRunning(c);
      const healthy = running && side?.has(c) === true;
      const unresponsive = running && side !== null && reg.partitionOf.has(c) && !side.has(c);
      if (reg.dndMarkFixed.delete(c) && state === 'degraded') {
        reg.dnd.set(c, 'ok');
        this.emitDnd(
          ctx,
          c,
          'dnd.node.cleared',
          `${c} marked fixed by the operator: Degraded cleared, its metadata store rejoins`,
        );
        continue;
      }
      if (healthy) this.dndDead.delete(c);
      if (state === 'ok') {
        if (!unresponsive || this.dndDead.has(c)) continue;
        reg.dnd.set(c, 'scoring');
        this.dndWindowEnd.set(c, ctx.now + D.scoringWindowS.value);
        this.wake(ctx, `${c} dnd scoring`, ctx.now + D.scoringWindowS.value, D.scoringWindowS);
        continue;
      }
      if (state === 'scoring') {
        if (ctx.now < (this.dndWindowEnd.get(c) ?? 0)) continue;
        if (!healthy) {
          reg.dnd.set(c, 'ok');
          this.dndDead.add(c);
          continue;
        }
        reg.dnd.set(c, 'degraded');
        this.dndHealthySince.set(c, ctx.now);
        this.emitDnd(
          ctx,
          c,
          'dnd.node.degraded',
          `${c} marked Degraded by Degraded Node Detection: it was unresponsive to its peers within the ${D.scoringWindowS.value} s scoring window. Its Cassandra goes to forwarding mode (metadata store disabled), so the cluster tolerates one node failure fewer; a degraded-node alert is raised`,
          'warn',
        );
        continue;
      }
      // Degraded: cleared only after a long healthy observation period.
      let since = this.dndHealthySince.get(c) ?? null;
      if (!healthy) since = null;
      else since ??= ctx.now;
      this.dndHealthySince.set(c, since);
      if (since === null) continue;
      const due = since + D.autoResolveHealthyS.value;
      this.wake(ctx, `${c} dnd resolve`, due, D.autoResolveHealthyS);
      if (ctx.now < due) continue;
      reg.dnd.set(c, 'ok');
      this.emitDnd(
        ctx,
        c,
        'dnd.node.cleared',
        `${c} healthy for ${D.autoResolveHealthyS.value} s: Degraded cleared automatically, its metadata store rejoins`,
      );
    }
    reg.dndMarkFixed.clear();
  }

  private emitDnd(
    ctx: Ctx,
    cvm: string,
    code: string,
    text: string,
    severity: 'info' | 'warn' = 'info',
  ): void {
    const D = ctx.profile.dnd;
    ctx.emit({
      severity,
      deviceId: cvm,
      code,
      text,
      causeIds: this.reg.causes.get(cvm) ?? [],
      cite: [...new Set([...D.enabled.cite, ...D.scoringWindowS.cite])],
      confidence: D.scoringWindowS.confidence,
    });
  }

  // ── Cassandra ring ──────────────────────────────────────────────────────

  private evalRing(ctx: Ctx): void {
    const reg = this.reg;
    const D = ctx.profile.cluster.cassandraRingDetachS;
    const R = ctx.profile.cluster.cassandraRejoinStableS;
    // A Degraded node's metadata store is disabled (forwarding mode): it holds no live replica.
    const live = (c: string) => reg.inQuorum(c) && reg.cvmCapable(c) && !reg.isDegraded(c);
    const rf = reg.metadataRf;
    for (const id of reg.facts.ringOrder) {
      const node = reg.cvms.get(id)?.cassandra;
      if (!node) continue;
      const ringSize = reg.facts.ringOrder.filter(
        (c) => reg.cvms.get(c)?.cassandra.state !== 'detached',
      ).length;
      if (node.state === 'detached') {
        if (!live(id)) {
          node.stableSince = null;
          continue;
        }
        node.stableSince ??= ctx.now;
        this.wake(ctx, `${id} ring rejoin`, node.stableSince + R.value, R);
        if (ctx.now - node.stableSince >= R.value) {
          node.state = 'normal';
          node.downSince = null;
          node.stableSince = null;
          ctx.emit({
            severity: 'info',
            deviceId: id,
            code: 'cassandra.node.rejoined',
            text: `${id} re-added to the metadata ring after being stable`,
            causeIds: [],
            cite: [...R.cite],
            confidence: R.confidence,
          });
        }
        continue;
      }
      if (live(id)) {
        node.state = 'normal';
        node.downSince = null;
        continue;
      }
      if (reg.isDegraded(id) && reg.inQuorum(id) && reg.cvmCapable(id)) {
        node.state = 'forwarding';
        node.downSince = null;
        continue;
      }
      node.state = 'down';
      node.downSince ??= ctx.now;
      this.wake(ctx, `${id} ring detach`, node.downSince + D.value, D);
      // Auto ring-repair needs a working cluster and enough nodes left for the metadata RF.
      const canDetach = reg.quorumSide !== null && ringSize - 1 >= rf;
      if (canDetach && ctx.now - node.downSince >= D.value) {
        node.state = 'detached';
        ctx.emit({
          severity: 'warn',
          deviceId: id,
          code: 'cassandra.node.detached',
          text: `${id} detached from the metadata ring after ${D.value} s down (auto ring-repair)`,
          causeIds: [],
          cite: D.cite,
          confidence: D.confidence,
        });
      }
    }

    if (reg.facts.externalStorage) {
      reg.metadataTolerance = null;
      reg.metaAvailable = reg.quorumSide !== null;
      reg.serviceTolerance = reg.quorumSide
        ? Math.max(0, reg.externalTolerance() - this.nodesDown())
        : 0;
      return;
    }
    const ring = reg.facts.ringOrder.filter((c) => reg.cvms.get(c)?.cassandra.state !== 'detached');
    const k = Math.min(rf, ring.length);
    const majority = Math.floor(k / 2) + 1;
    let ok = reg.quorumSide !== null && ring.length > 0;
    let slack = Number.POSITIVE_INFINITY;
    for (let i = 0; i < ring.length; i++) {
      let n = 0;
      for (let j = 0; j < k; j++) if (live(ring[(i + j) % ring.length] ?? '')) n++;
      if (n < majority) ok = false;
      slack = Math.min(slack, n - majority);
    }
    reg.metaAvailable = ok;
    reg.metadataTolerance = ok && Number.isFinite(slack) ? Math.max(0, slack) : 0;
    reg.serviceTolerance = ok
      ? Math.max(0, Math.min(reg.serviceTolerance, reg.ftConfigured, slack))
      : 0;
  }

  /** CVM-bearing nodes whose CVM is not running (T1 N−2 / N−3 accounting). */
  private nodesDown(): number {
    return this.reg.facts.cvms.filter((c) => !this.reg.cvmRunning(c.id)).length;
  }

  // ── Acropolis leader ────────────────────────────────────────────────────

  private evalLeader(ctx: Ctx): void {
    const reg = this.reg;
    const P = ctx.profile.ahvHa.leaderReelectionS;
    const valid = (host: string) => {
      const cvm = reg.facts.host(host)?.cvm ?? null;
      return cvm !== null && reg.hostAlive(host) && reg.cvmRunning(cvm) && reg.inQuorum(cvm);
    };
    if (reg.leaderHost !== null && !valid(reg.leaderHost)) {
      ctx.emit({
        severity: 'warn',
        deviceId: reg.leaderHost,
        code: 'ha.leader.lost',
        text: `Acropolis leader on ${reg.leaderHost} lost`,
        causeIds: [],
        cite: P.cite,
        confidence: P.confidence,
      });
      reg.leaderHost = null;
      reg.leaderLostAt = ctx.now;
    }
    if (reg.leaderHost !== null || reg.quorumSide === null) return;
    const due = reg.leaderLostAt + P.value;
    this.wake(ctx, 'acropolis re-election', due, P);
    if (ctx.now < due) return;
    const next = reg.facts.hosts.find((h) => valid(h.id));
    if (!next) return;
    reg.leaderHost = next.id;
    reg.leaderSince = ctx.now;
    ctx.emit({
      severity: 'info',
      deviceId: next.id,
      code: 'ha.leader.elected',
      text: `${next.label} elected Acropolis leader`,
      causeIds: [],
      cite: P.cite,
      confidence: P.confidence,
    });
  }

  // ── AHV HA ──────────────────────────────────────────────────────────────

  private evalHa(ctx: Ctx): void {
    const reg = this.reg;
    const P = ctx.profile.ahvHa;
    const now = ctx.now;
    const acting = reg.leaderActive() && now > reg.leaderSince;
    for (const h of reg.facts.hosts) {
      const ha = reg.haOf(h.id);
      // Hosts the leader cannot poll (no mgmt IP in the topology) are not tracked.
      if (!acting || (h.mgmtEndpoint === null && h.id !== reg.leaderHost)) continue;
      if (!reg.heartbeatMissing(h.id)) {
        if (ha.state !== 'connected') {
          ctx.emit({
            severity: 'info',
            deviceId: h.id,
            code: 'ha.host.connected',
            text: `${h.label} heartbeat restored`,
            causeIds: [],
            cite: P.heartbeatIntervalS.cite,
          });
        }
        Object.assign(ha, {
          state: 'connected',
          lostAt: null,
          disconnectAt: null,
          fenceAt: null,
          restartAt: null,
          causeId: null,
        });
        continue;
      }
      const lostAt = (reg.lastHeard.get(h.id) ?? 0) + P.heartbeatIntervalS.value;
      const disconnectAt = Math.max(lostAt + P.timeoutStartS.value, reg.leaderSince);
      const fenceAt = Math.max(
        lostAt + P.fenceAtS.value,
        disconnectAt + P.disconnectTimeoutS.value,
      );
      const restartAt = fenceAt + (P.restartByS.value - P.fenceAtS.value);
      Object.assign(ha, { lostAt, disconnectAt, fenceAt, restartAt });
      if (ha.state === 'connected') {
        this.wake(ctx, `${h.id} ha timeout start`, disconnectAt, P.timeoutStartS);
        if (now < disconnectAt) continue;
        ha.state = 'disconnected';
        ha.causeId = ctx.emit({
          severity: 'warn',
          deviceId: h.id,
          code: 'ha.host.disconnected',
          text: `${h.label}: no heartbeat since T=${lostAt - P.heartbeatIntervalS.value}; ${P.disconnectTimeoutS.value} s disconnect timeout started. Prism alert A1006 "Host IP Not Reachable"`,
          causeIds: [],
          cite: [...P.timeoutStartS.cite, 'ntnx-pe-alerts-7.0-cluster'],
          confidence: P.timeoutStartS.confidence,
        });
      }
      if (ha.state === 'disconnected') {
        this.wake(ctx, `${h.id} ha fence`, fenceAt, P.fenceAtS);
        if (now < fenceAt) continue;
        ha.state = 'fenced';
        ha.causeId = ctx.emit({
          severity: 'error',
          deviceId: h.id,
          code: 'ha.host.fenced',
          text: `${h.label} fenced: Stargates block its IO`,
          causeIds: ha.causeId === null ? [] : [ha.causeId],
          cite: P.fenceAtS.cite,
          confidence: P.fenceAtS.confidence,
        });
      }
      this.wake(ctx, `${h.id} ha restart`, restartAt, P.restartByS);
    }
    if (acting) this.restartVms(ctx);
  }

  private restartVms(ctx: Ctx): void {
    const reg = this.reg;
    const P = ctx.profile.ahvHa;
    const cycle = P.forceShutdownRestartCycles.value * P.heartbeatIntervalS.value;
    const load = this.load();
    for (const vm of [...reg.vms.values()].sort((a, b) => nodeOrder(a.id, b.id))) {
      if (vm.hasLiveInstance() || vm.restartNeed === 'none') continue;
      const home = reg.haOf(vm.homeHost);
      let due: boolean;
      if (vm.restartNeed === 'next-cycle') due = ctx.now - vm.restartNeedSince >= cycle;
      else if (home.state === 'fenced') {
        vm.beginRestart();
        due = home.restartAt !== null && ctx.now >= home.restartAt;
      } else {
        // The home host is back (or never went away): restart at the next cycle.
        due =
          home.state === 'connected' &&
          reg.hostAlive(vm.homeHost) &&
          !reg.heartbeatMissing(vm.homeHost);
      }
      if (!due) continue;
      vm.beginRestart();
      const target = this.pickHost(load);
      if (target === null) {
        if (!this.restartFailed.has(vm.id)) {
          this.restartFailed.add(vm.id);
          ctx.emit({
            severity: 'error',
            deviceId: vm.id,
            code: 'ha.vm.restart-failed',
            text: `${vm.label}: no host can run it now (capacity or array connectivity). Prism alert A1145 "Failure To Restart VMs For HA Event"`,
            causeIds: home.causeId === null ? [] : [home.causeId],
            cite: ['ntnx-pc-alerts-7.6-guestvm', ...P.restartByS.cite],
            confidence: 'inferred',
          });
        }
        continue;
      }
      this.restartFailed.delete(vm.id);
      load.set(target, (load.get(target) ?? 0) + 1);
      this.login(vm.vdisks, target);
      vm.startOn(target, ctx, home.causeId === null ? [] : [home.causeId], true);
    }
  }

  /**
   * Restart target: a powered, connected, unfenced host that may run VMs (never storage-only,
   * AHV Admin Guide 11.2); in T1 one whose CVM still reaches the array (DEPLOY-GUIDE). Least
   * loaded first, then lowest node id. Capacity is not modeled (`assumption`: best effort).
   */
  private pickHost(load: ReadonlyMap<string, number>): string | null {
    const ok = this.reg.facts.hosts.filter((h) => this.eligible(h.id));
    ok.sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || nodeOrder(a.id, b.id));
    return ok[0]?.id ?? null;
  }

  private eligible(host: string): boolean {
    const reg = this.reg;
    const h = reg.facts.host(host);
    if (!h || h.role === 'storage-only' || !reg.hostAlive(h.id)) return false;
    if (reg.haOf(h.id).state !== 'connected' || reg.heartbeatMissing(h.id)) return false;
    return !(h.cvm !== null && reg.facts.externalStorage && !reg.cvmCapable(h.cvm));
  }

  private load(): Map<string, number> {
    const load = new Map<string, number>();
    for (const v of this.reg.vms.values()) {
      if (v.host !== null) load.set(v.host, (load.get(v.host) ?? 0) + 1);
    }
    return load;
  }

  /** Fresh iSCSI logins on the target host; vDisk ownership follows its sessions. */
  private login(vdisks: readonly string[], host: string): void {
    const redirector = this.reg.hosts.get(host)?.redirector;
    for (const d of vdisks) {
      const cvm = redirector?.loginFresh(d) ?? null;
      if (cvm !== null) this.reg.owner.set(d, cvm);
    }
  }

  // ── Derived status ──────────────────────────────────────────────────────

  private computeHaStatus(): HaStatus {
    const reg = this.reg;
    if (reg.quorumSide === null) return 'Critical';
    const healing = [...reg.vms.values()].some(
      (v) => !v.hasLiveInstance() && v.restartNeed !== 'none' && v.currentState === 'restarting',
    );
    if (healing) return 'Healing';
    // AHV Admin Guide 11.2: Critical = cannot tolerate another host failure.
    return this.schedulableHosts() < 2 ? 'Critical' : 'OK';
  }

  /** Hosts that can take VMs now (not storage-only, alive, connected). */
  private schedulableHosts(): number {
    const reg = this.reg;
    return reg.facts.hosts.filter(
      (h) =>
        h.role !== 'storage-only' &&
        reg.hostAlive(h.id) &&
        reg.haOf(h.id).state === 'connected' &&
        !reg.heartbeatMissing(h.id),
    ).length;
  }

  /** A130068: the cluster could not restart VMs after another host failure. */
  private haResources(ctx: Ctx): void {
    // Judged by an acting leader only (its heartbeat view is what counts hosts).
    if (!this.reg.leaderActive() || this.reg.now <= this.reg.leaderSince) return;
    const short = this.schedulableHosts() < 2;
    if (short && !this.haShort) {
      ctx.emit({
        severity: 'warn',
        code: 'ha.resources.insufficient',
        text: 'Fewer than two hosts can run VMs: VMs are no longer protected against host failure. Prism alert A130068 "Insufficient Resources for VM High Availability"',
        causeIds: [],
        cite: ['ntnx-pc-alerts-7.6-guestvm', 'ntnx-ahv-admin-11.2'],
        confidence: 'inferred',
      });
    }
    this.haShort = short;
  }

  private computeDerived(): Record<string, ViewField> {
    const reg = this.reg;
    const quorum = reg.quorumSide !== null;
    const services = this.services;
    // HCI backend (stream G) data-path facts: tolerance = min(cluster services, data placement);
    // configured FT follows the backend's RF.
    let tolerance = reg.serviceTolerance;
    let ft = reg.ftConfigured;
    let extentGroups: number | null = null;
    if (!reg.facts.externalStorage) {
      for (const d of this.backendDerived()) {
        const dt = d['hci.dataNodeFailureTolerance'];
        if (typeof dt === 'number') {
          tolerance = Math.min(tolerance, dt);
          extentGroups = Math.max(0, dt);
        }
        const rf = d['hci.rf'];
        if (typeof rf === 'number') ft = Math.max(1, rf - 1);
      }
    }
    return {
      haStatus: this.haStatus,
      zkQuorum: quorum,
      zkLeader: reg.zkLeader,
      zkMembers: JSON.stringify([...reg.zkMembers].sort(nodeOrder)),
      acropolisLeader: reg.leaderHost,
      nodeFailureTolerance: Math.max(0, tolerance),
      ftConfigured: ft,
      metadataAvailable: reg.metaAvailable,
      degradedNodes: JSON.stringify(
        [...reg.dnd]
          .filter(([, st]) => st === 'degraded')
          .map(([c]) => c)
          .sort(nodeOrder),
      ),
      clusterServices: services,
      // Prism Element is a CVM cluster service with an elected leader (Bible): unreachable once
      // the services are down. Prism Central, a separate VM, then shows A200000.
      prismElement: services === 'up' ? 'up' : 'unreachable',
      prismCentralAlert: services === 'up' ? null : 'A200000',
      // Data Resiliency rows (`ncli cluster get-domain-fault-tolerance-status`, AHV Admin Guide
      // 11.2): node failures each component tolerates now. T1: metadata and extent groups are
      // the array's (null).
      faultToleranceByComponent: JSON.stringify({
        ZOOKEEPER: quorum ? reg.zkTolerance : 0,
        METADATA: reg.facts.externalStorage ? null : reg.metadataTolerance,
        EXTENT_GROUPS: extentGroups,
      }),
      // Data-path defaults. The HCI backend (G) overrides these through its `derived()`, which
      // the CVMs merge after this device (device ids sort after `cluster`). T1: the array owns
      // the data, so they are constant (docs/view-fields.md).
      resiliency: 'OK',
      dataAvailable: true,
      underReplicated: 0,
      blockAwareness: this.blockAwareness(),
    };
  }

  private backendDerived(): Readonly<Record<string, unknown>>[] {
    return [...new Set(this.reg.backends.values())].map((b) => b.derived?.() ?? {});
  }

  /**
   * Bible 4i block fault tolerance: ≥ 3 blocks, and with X nodes in the largest block the others
   * hold ≥ 2X (FT1) / ≥ 4X (FT2). `off` when every block is a single node (or no blocks).
   */
  private blockAwareness(): 'met' | 'not-met' | 'off' {
    const reg = this.reg;
    const counts = new Map<string, number>();
    for (const h of reg.facts.hosts) {
      if (h.cvm === null || h.block === null) continue;
      counts.set(h.block, (counts.get(h.block) ?? 0) + 1);
    }
    const sizes = [...counts.values()];
    if (sizes.length === 0 || sizes.every((n) => n === 1)) return 'off';
    const x = Math.max(...sizes);
    const rest = sizes.reduce((a, b) => a + b, 0) - x;
    const need = (reg.ftConfigured >= 2 ? 4 : 2) * x;
    return sizes.length >= 3 && rest >= need ? 'met' : 'not-met';
  }

  private advisories(ctx: Ctx): void {
    const reg = this.reg;
    if (!reg.facts.externalStorage) {
      // FT1 needs 3 CVM nodes, FT2 needs 5 (Bible 4i; profile `cluster.minNodes` for FT1).
      const minUnits = Math.max(ctx.profile.cluster.minNodes.value, 2 * reg.ftConfigured + 1);
      const running = reg.facts.cvms.filter((c) => reg.cvmRunning(c.id)).length;
      const short = running < minUnits;
      if (short && !this.ftShort) {
        ctx.emit({
          severity: 'warn',
          code: 'cluster.ft.insufficient-nodes',
          text: `FT${reg.ftConfigured} needs ${minUnits} CVM nodes; ${running} are running`,
          causeIds: [],
          cite: ctx.profile.cluster.minNodes.cite,
          confidence: ctx.profile.cluster.minNodes.confidence,
        });
      }
      this.ftShort = short;
    }
    if (!this.advised) {
      this.advised = true;
      const co = reg.facts.hosts.filter((h) => h.role === 'compute-only').length;
      const hci = reg.facts.hosts.filter((h) => h.role === 'hci').length;
      // Community sizing guidance: about 2 HCI : 1 CO (advisory only).
      if (co > 0 && hci > 0 && co > hci / 2) {
        ctx.emit({
          severity: 'warn',
          code: 'cluster.advisory.co-ratio',
          text: `${co} compute-only nodes on ${hci} HCI nodes: guidance is about 1 CO per 2 HCI`,
          causeIds: [],
          cite: ['ntnx-community-co-nodes-blog', 'ntnx-community-co-nodes'],
          confidence: 'unverified',
        });
      }
    }
  }

  /** Keep a (no-op) engine timer at `at`, so "fast-forward to next timer" stops there. */
  private wake(
    ctx: Ctx,
    name: string,
    at: number,
    src: { readonly cite: TimerOptions['cite']; readonly confidence: TimerOptions['confidence'] },
  ): void {
    const prev = this.wakes.get(name);
    if (prev && prev.dueAt === at) return;
    if (prev) ctx.timers.cancel(prev);
    this.wakes.delete(name);
    if (at <= ctx.now) return;
    this.wakes.set(
      name,
      ctx.timers.set(name, at - ctx.now, { cite: src.cite, confidence: src.confidence }, () => {
        this.wakes.delete(name);
      }),
    );
  }
}
