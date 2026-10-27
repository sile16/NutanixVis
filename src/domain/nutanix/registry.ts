/**
 * Shared Nutanix cluster state: what Zookeeper/Zeus, the Cassandra ring and the Acropolis leader
 * collectively know. Devices (hosts, CVMs, VMs, the cluster device) read and update it; it also
 * implements the `ClusterView` stream F exposes to E and G, and the `VmEnv` the workload uses.
 *
 * Model shortcut (documented): facts that the real cluster distributes through Zookeeper (fenced
 * hosts, quorum side, vDisk owners) are read here directly rather than via simulated messages.
 */

import type { DeviceId, EndpointId } from '../../engine/types';
import type { ClusterView, Ctx, IoRequest, StorageBackend } from '../contracts';
import type { Profile } from '../versions/profile';
import type { IoTarget, StorageUse, Vm, VmEnv } from '../workload/vm';
import type { Cvm } from './cvm';
import type { Facts } from './facts';
import type { AhvHost } from './host';

export type HaState = 'connected' | 'disconnected' | 'fenced';

export interface HostHa {
  state: HaState;
  /** First tick its heartbeat was missing (T in Bible 5b's "T+20 / T+60 / T+120"). */
  lostAt: number | null;
  disconnectAt: number | null;
  fenceAt: number | null;
  restartAt: number | null;
  /** Latest HA event for this host (cause of the next step in the chain). */
  causeId: string | null;
}

/** Stream F's `ClusterView` (kept as an alias; the contract now carries every method). */
export type NutanixClusterView = ClusterView;

export class Registry implements NutanixClusterView, VmEnv {
  readonly hosts = new Map<string, AhvHost>();
  readonly cvms = new Map<string, Cvm>();
  readonly vms = new Map<string, Vm>();
  readonly backends = new Map<string, StorageBackend>();
  /** vDisk → owning CVM. */
  readonly owner = new Map<string, string>();
  /** VMs a `power-on` action asked to start (handled by the cluster device). */
  readonly powerOnRequests = new Set<string>();
  /** Cause event ids recorded by our actions, per target (for causal chains). */
  readonly causes = new Map<string, readonly string[]>();

  // Zookeeper
  quorumSide: ReadonlySet<string> | null;
  readonly partitionOf = new Map<string, string>();
  zkMembers: ReadonlySet<string>;
  zkLeader: string | null;
  metaAvailable = true;
  serviceTolerance = 0;

  // Acropolis / AHV HA
  leaderHost: string | null;
  leaderSince = 0;
  leaderLostAt = 0;
  readonly lastHeard = new Map<string, number>();
  readonly ha = new Map<string, HostHa>();

  now = 0;
  private readonly vdiskIndex: ReadonlyMap<string, number>;

  constructor(
    readonly facts: Facts,
    readonly profile: Profile,
    backendFor: (cvm: DeviceId) => StorageBackend,
  ) {
    for (const c of facts.cvms) this.backends.set(c.id, backendFor(c.id));
    // Round-robin index over the vDisks of hosts without a local CVM first (so the default CO
    // VMs spread over every CVM), then everyone else's.
    const co = new Set(facts.hosts.filter((h) => h.cvm === null).map((h) => h.id));
    const vds = [
      ...facts.vms.filter((v) => co.has(v.host)),
      ...facts.vms.filter((v) => !co.has(v.host)),
    ].flatMap((v) => v.vdisks);
    this.vdiskIndex = new Map(vds.map((d, i) => [d, i] as const));
    const all = facts.cvms.map((c) => c.id);
    this.quorumSide = new Set(all);
    for (const c of all) this.partitionOf.set(c, all[0] ?? c);
    this.zkMembers = new Set(initialZkMembers(facts, profile));
    this.zkLeader = [...this.zkMembers][0] ?? null;
    // SPEC §14 #8: the initial Acropolis leader is the lowest node id (with a CVM to run it).
    this.leaderHost = facts.hosts.find((h) => h.cvm !== null)?.id ?? null;
    this.serviceTolerance = facts.externalStorage
      ? this.externalTolerance()
      : Math.min(this.ftConfigured, Math.floor((this.zkMembers.size - 1) / 2));
    for (const h of facts.hosts) {
      this.lastHeard.set(h.id, 0);
      this.ha.set(h.id, {
        state: 'connected',
        lostAt: null,
        disconnectAt: null,
        fenceAt: null,
        restartAt: null,
        causeId: null,
      });
    }
    for (const v of facts.vms) {
      for (const d of v.vdisks) {
        const pref = this.preferredCvm(v.host, d);
        if (pref !== null) this.owner.set(d, pref);
      }
    }
  }

  // ── Configuration-derived rules ─────────────────────────────────────────

  /** Configured FT (docs/view-fields.md `ftConfigured`). RF3 = FT2. T1: see `externalFt`. */
  get ftConfigured(): number {
    const rf = this.facts.replicationFactor;
    if (rf === null) return 1;
    return Math.min(2, Math.max(1, rf - 1));
  }

  /** ZK ensemble size: 3 under FT1, 5 under FT2 (profile `zkMembersFt1/Ft2`), capped at N. */
  get zkEnsembleSize(): number {
    const C = this.profile.cluster;
    const m = this.ftConfigured >= 2 ? C.zkMembersFt2.value : C.zkMembersFt1.value;
    return Math.min(m, this.facts.cvms.length);
  }

  /** Metadata RF: 3 under FT1, 5 under FT2 (Bible 4i), i.e. 2·FT + 1. */
  get metadataRf(): number {
    return 2 * this.ftConfigured + 1;
  }

  /** T1: simultaneous node failures tolerated, N−2 below 5 nodes, N−3 at 5+ (DEPLOY-GUIDE). */
  externalTolerance(): number {
    const n = this.facts.cvms.length;
    const t = this.profile.externalStorage.nodeFailureTolerance.value;
    return Math.max(0, n - (n < 5 ? t.belowFiveNodes : t.fiveOrMore));
  }

  /**
   * CVM that serves a vDisk by default: the local CVM, or for a host without one (compute-only)
   * a CVM chosen round-robin over the CVM nodes by vDisk (`assumption`: Nutanix documents CO
   * placement only as "heuristics-based").
   */
  preferredCvm(host: string, vdisk: string): string | null {
    const local = this.facts.host(host)?.cvm ?? null;
    if (local !== null) return local;
    const cvms = this.facts.cvms;
    if (cvms.length === 0) return null;
    const idx = this.vdiskIndex.get(vdisk) ?? 0;
    return cvms[idx % cvms.length]?.id ?? null;
  }

  // ── Liveness ────────────────────────────────────────────────────────────

  hostAlive(host: string): boolean {
    return this.hosts.get(host)?.alive() ?? false;
  }

  cvmRunning(cvm: string): boolean {
    return this.cvms.get(cvm)?.running() ?? false;
  }

  /** T1: the CVM reaches its cluster-service volumes on the array. */
  cvmCapable(cvm: string): boolean {
    if (!this.cvmRunning(cvm)) return false;
    if (!this.facts.externalStorage) return true;
    return this.backends.get(cvm)?.health() !== 'unavailable';
  }

  inQuorum(cvm: string): boolean {
    return this.quorumSide?.has(cvm) ?? false;
  }

  haOf(host: string): HostHa {
    const h = this.ha.get(host);
    if (!h) throw new Error(`no HA state for ${host}`);
    return h;
  }

  /** The Acropolis leader exists and can act (its CVM is on the quorum side). */
  leaderActive(): boolean {
    return this.leaderHost !== null && this.quorumSide !== null;
  }

  leaderCvm(): string | null {
    return this.leaderHost === null ? null : (this.facts.host(this.leaderHost)?.cvm ?? null);
  }

  /**
   * The current leader is missing this host's heartbeat. A newly elected leader judges hosts only
   * from its own polls (from `leaderSince`); the loss time T it inherits from Zeus is separate.
   */
  heartbeatMissing(host: string): boolean {
    const last = Math.max(this.lastHeard.get(host) ?? 0, this.leaderSince);
    return this.now - last >= this.profile.ahvHa.heartbeatIntervalS.value;
  }

  // ── ClusterView (for streams E and G) ───────────────────────────────────

  cvmIds(): readonly DeviceId[] {
    return this.facts.cvms.map((c) => c.id);
  }
  isCvmUp(cvm: DeviceId): boolean {
    return this.cvmRunning(cvm);
  }
  isStargateUp(cvm: DeviceId): boolean {
    const c = this.cvms.get(cvm);
    return !!c && c.stargateServing() && !this.isHostFenced(c.hostId);
  }
  cvmDataEndpoint(cvm: DeviceId): EndpointId {
    const f = this.facts.cvm(cvm);
    if (!f) throw new Error(`unknown CVM ${cvm}`);
    return f.dataEndpoint;
  }
  cvmStorageEndpoints(cvm: DeviceId): readonly EndpointId[] {
    return this.facts.cvm(cvm)?.storageEndpoints ?? [];
  }
  zkQuorum(): boolean {
    return this.quorumSide !== null;
  }
  metadataAvailable(): boolean {
    return this.metaAvailable;
  }
  isHostFenced(host: DeviceId): boolean {
    return this.ha.get(host)?.state === 'fenced';
  }
  serviceFailureTolerance(): number {
    return this.serviceTolerance;
  }
  vdiskOwner(vdisk: string): DeviceId | null {
    return this.owner.get(vdisk) ?? null;
  }

  /** A Stargate took ownership: everyone else holding the vDisk must release it. */
  setOwner(vdisk: string, cvm: string): void {
    this.owner.set(vdisk, cvm);
    for (const [id, c] of this.cvms) if (id !== cvm) c.relinquish(vdisk);
  }

  // ── VmEnv (for the workload) ────────────────────────────────────────────

  hostFenced(host: string): boolean {
    return this.isHostFenced(host);
  }

  /**
   * Isolation as seen by the cluster: an active Acropolis leader on the quorum side has lost the
   * host's heartbeat (or fenced it). With no quorum anywhere this is false (SPEC §14 #1).
   */
  hostCutOff(host: string): boolean {
    if (!this.leaderActive() || this.now <= this.leaderSince) return false;
    if (this.isHostFenced(host)) return true;
    return host !== this.leaderHost && this.heartbeatMissing(host);
  }

  target(host: string, vdisk: string): IoTarget {
    return this.hosts.get(host)?.redirector.target(vdisk) ?? { status: 'no-path' };
  }

  send(host: string, _vm: string, io: IoRequest, ctx: Ctx): string | null {
    return this.hosts.get(host)?.redirector.sendIo(io, ctx) ?? null;
  }

  ownerCvm(vdisk: string): string | null {
    return this.owner.get(vdisk) ?? null;
  }

  storageUse(vdisk: string): StorageUse {
    const cvm = this.owner.get(vdisk);
    const b = cvm === undefined ? undefined : this.backends.get(cvm);
    const raw = b?.pathsFor?.(vdisk) ?? [];
    const paths: string[] = [];
    const uplinks: string[] = [];
    for (const x of raw) {
      if (x.includes('~')) paths.push(x);
      else if (this.facts.nicOwner.has(x)) uplinks.push(x);
      else {
        const nic = this.facts.linkHostNic.get(x);
        if (nic !== undefined) uplinks.push(nic);
      }
    }
    return { paths, uplinks };
  }

  storageLost(vdisk: string): boolean {
    if (!this.facts.externalStorage) return false;
    const cvm = this.owner.get(vdisk);
    return cvm !== undefined && this.backends.get(cvm)?.health() === 'unavailable';
  }

  hostOfNic(nic: string): string | undefined {
    return this.facts.nicOwner.get(nic);
  }
}

/**
 * ZK seats: the first `zkEnsembleSize` CVMs in block-aware ring order, i.e. the lowest-id CVM
 * nodes, one per block where possible (Bible 4i: ZK on 3 or 5 nodes; block awareness).
 */
export function initialZkMembers(facts: Facts, profile: Profile): string[] {
  const rf = facts.replicationFactor;
  const ft = rf === null ? 1 : Math.min(2, Math.max(1, rf - 1));
  const C = profile.cluster;
  const m = Math.min(ft >= 2 ? C.zkMembersFt2.value : C.zkMembersFt1.value, facts.cvms.length);
  return facts.ringOrder.slice(0, m);
}
