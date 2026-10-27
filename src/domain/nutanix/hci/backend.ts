/**
 * One CVM's HCI `StorageBackend` (kind `hci`): the Stargate ↔ extent-store leg in T2/T3.
 *
 * Writes (Bible 4g "Data I/O path"): the write lands in the serving Stargate's local Oplog and
 * is replicated synchronously to the other replicas' CVMs with `hci-replication`; it completes
 * only when every replica has acked. An unreachable replica is replaced by another healthy node
 * and the extent group stays under-replicated until Curator rebuilds it (Bible 4i). A write that
 * reaches a non-local Stargate (the VM's own CVM is down) writes all RF copies remotely.
 *
 * Reads: from a live local replica if there is one, otherwise from a remote one
 * (`hci-read` → `hci-read-resp`). Checksums and scrubbing are out of scope.
 *
 * IO whose extent group has no reachable copy, or while metadata is unavailable, hangs and is
 * retried every tick (the beyond-FT outcome is `unverified`, SPEC §6.3).
 */
import { asEngineContext } from '../../../engine/context';
import type { DeviceId, EndpointId, Message, ViewField } from '../../../engine/types';
import type { ClusterView, Ctx, IoCompletion, IoRequest, StorageBackend } from '../../contracts';
import { HCI_ASSUMPTIONS, STARGATE_PORT } from './assumptions';
import {
  type AckPayload,
  isPayload,
  MSG,
  type RebuildAckPayload,
  type ReplicatePayload,
} from './messages';
import type { ExtentGroup, HciStore } from './store';

interface Target {
  readonly disk: DeviceId;
  msgId: string | undefined;
  sentAt: number;
  acked: boolean;
  latencyMs: number;
}

interface Pending {
  readonly req: IoRequest;
  readonly eg: ExtentGroup;
  readonly tried: Set<DeviceId>;
  /** Writes: replica node → state. Reads: the single source being asked. */
  targets: Map<DeviceId, Target>;
  hung: boolean;
}

export class HciBackend implements StorageBackend {
  readonly kind = 'hci';
  readonly name = 'hci-extent-store';
  private cluster: ClusterView | undefined;
  private readonly pending = new Map<string, Pending>();
  private completions: IoCompletion[] = [];
  private readonly owned = new Set<string>();
  private paths = new Map<string, Set<EndpointId>>();

  constructor(
    readonly cvm: DeviceId,
    /** Shared cluster extent store (read-only use outside this module: inspectors, tests). */
    readonly store: HciStore,
    private readonly anchor: boolean,
  ) {}

  attach(cluster: ClusterView): void {
    this.cluster = cluster;
    this.store.attach(cluster);
  }

  /** HCI has no reservation: ownership is Stargate's vDisk token (Bible 4a). Tracked for views. */
  acquire(vdisk: string): void {
    this.owned.add(vdisk);
    this.store.ensureVdisk(vdisk, this.cvm);
  }

  release(vdisk: string): void {
    this.owned.delete(vdisk);
  }

  submit(req: IoRequest, ctx: Ctx): void {
    if (req.op === 'write' && this.store.readOnly()) {
      this.complete(req, ctx, {
        status: 'error',
        reason: `Stargate is read-only: storage at or above ${ctx.profile.hci.readOnlyCapacityPct.value}% (Bible 4i)`,
      });
      return;
    }
    const eg = this.store.nextExtentGroup(req.vdisk, this.cvm, req.op);
    if (eg === undefined) {
      this.complete(req, ctx, { status: 'error', reason: 'no CVM node can hold data' });
      return;
    }
    const p: Pending = { req, eg, tried: new Set(), targets: new Map(), hung: false };
    this.pending.set(req.id, p);
    this.dispatch(p, ctx);
  }

  drain(): readonly IoCompletion[] {
    const out = this.completions;
    this.completions = [];
    return out;
  }

  health(): 'ok' | 'degraded' | 'unavailable' {
    if (!this.store.metadataAvailable()) return 'unavailable';
    const reachable = this.store
      .extentGroups()
      .some((eg) => this.store.liveReplicas(eg).length > 0);
    if (!reachable) return 'unavailable';
    if (!this.store.dataAvailable() || this.store.underReplicated() > 0 || this.store.readOnly()) {
      return 'degraded';
    }
    return 'ok';
  }

  pathsFor(vdisk: string): readonly string[] {
    return [...(this.paths.get(vdisk) ?? [])].sort();
  }

  // ── Hooks delegated by the owning CVM ─────────────────────────────────────

  preTick(): void {
    this.paths = new Map();
  }

  onMessage(msg: Message, ctx: Ctx): boolean {
    switch (msg.kind) {
      case MSG.replicate:
      case MSG.read: {
        const p = msg.payload;
        if (!isPayload<ReplicatePayload>(p, 'disk')) return true;
        // A replica acks only if its Stargate is serving and the disk is online.
        if (this.store.nodeServing(this.cvm) && this.store.diskServing(p.disk)) {
          this.reply(msg, msg.kind === MSG.replicate ? MSG.replicateAck : MSG.readResp, ctx, {
            io: p.io,
            node: this.cvm,
          });
        }
        return true;
      }
      case MSG.replicateAck:
      case MSG.readResp: {
        const p = msg.payload;
        if (!isPayload<AckPayload>(p, 'io')) return true;
        const io = this.pending.get(p.io);
        const t = io?.targets.get(p.node);
        if (io === undefined || t === undefined || t.acked) return true;
        const e = asEngineContext(ctx);
        t.acked = true;
        t.latencyMs =
          (t.msgId === undefined ? 0 : (e.trace(t.msgId)?.latencyMs ?? 0)) +
          (e.trace(msg.id)?.latencyMs ?? 0);
        this.finishIfDone(io, ctx);
        return true;
      }
      case MSG.rebuild:
        if (this.store.nodeServing(this.cvm)) {
          ctx.send<RebuildAckPayload>({
            kind: MSG.rebuildAck,
            src: msg.dst,
            dst: msg.src,
            size: 'small',
            flow: asEngineContext(ctx).flow(msg.dst, msg.src, {
              proto: 'tcp',
              srcPort: STARGATE_PORT,
            }),
            payload: { ref: msg.id },
            causeId: msg.id,
          });
        }
        return true;
      case MSG.rebuildAck:
        if (isPayload<RebuildAckPayload>(msg.payload, 'ref')) {
          this.store.noteRebuildAck(msg.payload.ref);
        }
        return true;
      default:
        return false;
    }
  }

  tick(ctx: Ctx): void {
    const e = asEngineContext(ctx);
    const timeout = HCI_ASSUMPTIONS.replicaAckTimeoutS.value;
    for (const p of [...this.pending.values()]) {
      if (p.hung) {
        p.hung = false;
        p.tried.clear();
        p.targets = new Map();
        this.dispatch(p, ctx);
        continue;
      }
      let failed = false;
      for (const [node, t] of p.targets) {
        if (t.acked) continue;
        const dropped = t.msgId !== undefined && e.trace(t.msgId)?.result === 'dropped';
        if (
          dropped ||
          !this.store.nodeServing(node) ||
          !this.store.diskServing(t.disk) ||
          ctx.now - t.sentAt >= timeout
        ) {
          p.tried.add(node);
          p.targets.delete(node);
          failed = true;
        }
      }
      if (failed) this.dispatch(p, ctx);
    }
    this.store.advance(ctx);
  }

  /** IO in flight on a Stargate that went down is lost with it; the VM side retries. */
  onFail(): void {
    this.pending.clear();
    this.paths = new Map();
  }

  viewFields(): Readonly<Record<string, ViewField>> {
    return {
      'hci.replicas': this.store.replicasOn(this.cvm),
      'hci.ioPending': this.pending.size,
      'hci.vdisksOwned': this.owned.size,
      'hci.readOnly': this.store.readOnly(),
    };
  }

  derived(): Readonly<Record<string, ViewField>> {
    return this.anchor ? this.store.derived() : {};
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private dispatch(p: Pending, ctx: Ctx): void {
    if (!this.store.metadataAvailable()) {
      p.hung = true;
      return;
    }
    if (p.req.op === 'read') this.dispatchRead(p, ctx);
    else this.dispatchWrite(p, ctx);
  }

  private dispatchWrite(p: Pending, ctx: Ctx): void {
    const pinned = new Map([...p.targets].map(([n, t]) => [n, t.disk]));
    const plan = this.store.writePlan(p.eg, p.tried, pinned);
    if (plan === undefined) {
      p.hung = true;
      return;
    }
    for (const t of plan) {
      if (p.targets.has(t.node)) continue;
      const target: Target = {
        disk: t.disk,
        msgId: undefined,
        sentAt: ctx.now,
        acked: false,
        latencyMs: 0,
      };
      if (t.node === this.cvm) {
        target.acked = true; // local Oplog write
      } else {
        target.msgId = this.send(p, t.node, MSG.replicate, 'large', t.disk, ctx);
      }
      p.targets.set(t.node, target);
    }
    this.finishIfDone(p, ctx);
  }

  private dispatchRead(p: Pending, ctx: Ctx): void {
    const src = this.store.readSource(p.eg, this.cvm, p.tried);
    if (src === undefined) {
      p.hung = true;
      return;
    }
    const target: Target = {
      disk: src.disk,
      msgId: undefined,
      sentAt: ctx.now,
      acked: false,
      latencyMs: 0,
    };
    p.targets = new Map([[src.node, target]]);
    if (src.node === this.cvm) {
      target.acked = true;
      this.finishIfDone(p, ctx);
    } else {
      target.msgId = this.send(p, src.node, MSG.read, 'small', src.disk, ctx);
    }
  }

  private finishIfDone(p: Pending, ctx: Ctx): void {
    if (p.hung || p.targets.size === 0) return;
    for (const t of p.targets.values()) if (!t.acked) return;
    if (p.req.op === 'write') {
      if (p.targets.size < this.store.rf) return;
      this.store.commitWrite(p.eg, new Map([...p.targets].map(([n, t]) => [n, t.disk])));
    }
    this.pending.delete(p.req.id);
    const latencyMs = Math.max(0, ...[...p.targets.values()].map((t) => t.latencyMs));
    this.complete(p.req, ctx, { status: 'ok', latencyMs });
  }

  private complete(req: IoRequest, ctx: Ctx, outcome: IoCompletion['outcome']): void {
    this.completions.push({ req, outcome, completedAt: ctx.now });
  }

  private send(
    p: Pending,
    node: DeviceId,
    kind: string,
    size: 'small' | 'large',
    disk: DeviceId,
    ctx: Ctx,
  ): string | undefined {
    const c = this.cluster;
    if (c === undefined) return undefined;
    const src = c.cvmDataEndpoint(this.cvm);
    const dst = c.cvmDataEndpoint(node);
    const set = this.paths.get(p.req.vdisk) ?? new Set<EndpointId>();
    set.add(dst);
    this.paths.set(p.req.vdisk, set);
    return ctx.send<ReplicatePayload>({
      kind,
      src,
      dst,
      size,
      flow: asEngineContext(ctx).flow(src, dst, { proto: 'tcp', dstPort: STARGATE_PORT }),
      payload: { io: p.req.id, eg: p.eg.id, disk, from: this.cvm },
      causeId: p.req.id,
    });
  }

  private reply(msg: Message, kind: string, ctx: Ctx, payload: AckPayload): void {
    ctx.send<AckPayload>({
      kind,
      src: msg.dst,
      dst: msg.src,
      size: kind === MSG.readResp ? 'large' : 'small',
      flow: asEngineContext(ctx).flow(msg.dst, msg.src, {
        proto: 'tcp',
        srcPort: STARGATE_PORT,
      }),
      payload,
      causeId: msg.causeId ?? msg.id,
    });
  }
}
