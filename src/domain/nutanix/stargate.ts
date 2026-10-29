/**
 * Stargate (SPEC §6.2): serves vDisk IO from hosts' iSCSI sessions through the CVM's
 * `StorageBackend` (E's NVMe initiator in T1, G's extent store in T2/T3), answers redirector
 * NOPs, and owns vDisks via `backend.acquire` (T1: the NVMe Persistent Reservation, Bible 8c).
 *
 * - IO from a host AHV HA has fenced is refused (Bible 5b: "Stargates block IO from that host").
 * - Without ZK quorum the Stargate is `unhealthy`: it still answers NOPs (so the redirector does
 *   not move), but refuses writes, which need quorum-backed metadata (`inferred`; this is also
 *   what makes VM writes fail on an isolated host, Bible 5b / SPEC §6.4a "Host network
 *   isolation"). HCI: reads are refused too, because resolving an extent needs a Cassandra
 *   lookup and no key range has a Paxos majority outside the quorum side (`inferred`, Bible
 *   4g/4i). T1 keeps serving reads (metadata is the array's).
 * - Replies dropped on the wire are retransmitted (TCP) while the Stargate is serving.
 * - T1 vDisk handover: taking over a vDisk whose owner CVM went into Hades maintenance takes
 *   `externalStorage.vdiskHandoverS` (ownership and NVMe reservation, `assumption`). The session
 *   is redirected at once, but its IO waits here until the handover completes.
 */

import { asEngineContext } from '../../engine/context';
import type { Message, MessageDraft } from '../../engine/types';
import type { Ctx, CvmComponent, IoRequest, StorageBackend } from '../contracts';
import {
  type IoPayload,
  type IoReply,
  type IoRespPayload,
  isIoKind,
  MSG,
  type PingPayload,
} from './messages';
import type { Registry } from './registry';

interface Inflight {
  readonly req: IoRequest;
  /** Our endpoint the request arrived on, and the host endpoint to answer. */
  readonly local: string;
  readonly remote: string;
  readonly flow: Message['flow'];
  readonly kind: string;
}

export class Stargate implements CvmComponent {
  readonly name = 'stargate';
  private process: 'up' | 'down' = 'up';
  private readonly acquired = new Set<string>();
  private readonly inflight = new Map<string, Inflight>();
  private toRelease = new Set<string>();
  private resend: MessageDraft[] = [];
  private sentReplies: { id: string; draft: MessageDraft; at: number }[] = [];
  /** T1 handover in progress: vDisk → time this Stargate may serve it, and the old owner. */
  private readonly handover = new Map<
    string,
    { readonly readyAt: number; readonly from: string }
  >();
  /** IO waiting for a handover, by IO id. */
  private readonly waiting = new Map<string, Inflight>();

  constructor(
    private readonly cvm: string,
    private readonly backend: StorageBackend,
    private readonly reg: Registry,
  ) {}

  get processUp(): boolean {
    return this.process === 'up';
  }

  /** Serving IO (process up). `unhealthy` is reported separately (no quorum). */
  setProcess(up: boolean): void {
    this.process = up ? 'up' : 'down';
    if (!up) this.clear();
  }

  ownedVdisks(): number {
    return this.acquired.size;
  }

  /** Another Stargate took the vDisk; release it at our next preTick. */
  relinquish(vdisk: string): void {
    if (this.acquired.has(vdisk)) this.toRelease.add(vdisk);
  }

  preTick(ctx: Ctx): void {
    for (const v of [...this.toRelease].sort()) {
      if (!this.acquired.delete(v)) continue;
      if (this.process === 'up') this.backend.release(v, ctx);
    }
    this.toRelease = new Set();
    if (this.process === 'up') this.finishHandovers(ctx);
  }

  /** A vDisk whose current owner CVM is in Hades maintenance (T1): taking it over takes time. */
  private handoverFrom(vdisk: string): string | null {
    if (!this.reg.facts.externalStorage) return null;
    const owner = this.reg.owner.get(vdisk);
    if (owner === undefined || owner === this.cvm) return null;
    const state = this.reg.cvms.get(owner)?.hades.state ?? 'ok';
    return state === 'ok' ? null : owner;
  }

  private finishHandovers(ctx: Ctx): void {
    for (const [vdisk, h] of [...this.handover].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (ctx.now < h.readyAt) continue;
      this.handover.delete(vdisk);
      this.take(vdisk, ctx);
      ctx.emit({
        severity: 'info',
        deviceId: this.cvm,
        code: 'stargate.vdisk.taken-over',
        text: `${this.cvm} took over ${vdisk} from ${h.from}; its IO is served again`,
        causeIds: [],
        cite: ctx.profile.externalStorage.vdiskHandoverS.cite,
        confidence: ctx.profile.externalStorage.vdiskHandoverS.confidence,
      });
      for (const [id, e] of [...this.waiting]) {
        if (e.req.vdisk !== vdisk) continue;
        this.waiting.delete(id);
        this.inflight.set(id, e);
        this.backend.submit(e.req, ctx);
      }
    }
  }

  /** Take ownership: NVMe reservation (T1) and the cluster's vDisk owner. */
  private take(vdisk: string, ctx: Ctx): void {
    this.backend.acquire(vdisk, ctx);
    this.acquired.add(vdisk);
    this.toRelease.delete(vdisk);
    this.reg.setOwner(vdisk, this.cvm);
  }

  emit(ctx: Ctx): void {
    if (this.process !== 'up') {
      this.resend = [];
      return;
    }
    const drafts = this.resend;
    this.resend = [];
    for (const d of drafts) this.track(ctx.send(d), d, ctx.now);
  }

  onMessage(msg: Message, ctx: Ctx): boolean {
    if (msg.kind === MSG.nop) {
      const p = msg.payload as PingPayload;
      if (p.t === 'req' && this.process === 'up') {
        const reply: PingPayload = { t: 'resp', from: this.cvm };
        ctx.send({
          kind: MSG.nop,
          src: msg.dst,
          dst: msg.src,
          size: 'small',
          flow: reverse(msg, ctx),
          payload: reply,
        });
      }
      return true;
    }
    if (!isIoKind(msg.kind)) return false;
    const p = msg.payload as IoPayload;
    if (p.t !== 'req' || this.process !== 'up') return true;
    const io = p.io;
    const entry: Inflight = {
      req: io,
      local: msg.dst,
      remote: msg.src,
      flow: reverse(msg, ctx),
      kind: msg.kind,
    };
    if (this.reg.isHostFenced(p.host)) {
      this.reply(entry, { status: 'retry', reason: 'host fenced by AHV HA' }, ctx);
      return true;
    }
    const needsQuorum = io.op === 'write' || !this.reg.facts.externalStorage;
    if (needsQuorum && !this.reg.inQuorum(this.cvm)) {
      this.reply(entry, { status: 'retry', reason: 'no Zookeeper quorum' }, ctx);
      return true;
    }
    if (this.inflight.has(io.id)) {
      this.inflight.set(io.id, entry);
      return true;
    }
    if (this.waiting.has(io.id) || this.handover.has(io.vdisk)) {
      this.waiting.set(io.id, entry);
      return true;
    }
    if (!this.acquired.has(io.vdisk)) {
      const from = this.handoverFrom(io.vdisk);
      if (from !== null) {
        const H = ctx.profile.externalStorage.vdiskHandoverS;
        this.handover.set(io.vdisk, { readyAt: ctx.now + H.value, from });
        this.waiting.set(io.id, entry);
        ctx.emit({
          severity: 'warn',
          deviceId: this.cvm,
          code: 'stargate.vdisk.handover',
          text: `${this.cvm} is taking over ${io.vdisk} from ${from} (in Hades maintenance): ownership and NVMe reservation handover, IO waits about ${H.value} s`,
          causeIds: [],
          cite: H.cite,
          confidence: H.confidence,
        });
        return true;
      }
      this.take(io.vdisk, ctx);
    }
    this.inflight.set(io.id, entry);
    this.backend.submit(io, ctx);
    return true;
  }

  /** Answer every completion the backend has (called after delivery and in tick). */
  pump(ctx: Ctx): void {
    const done = this.backend.drain();
    if (this.process !== 'up') return;
    for (const c of done) {
      const e = this.inflight.get(c.req.id);
      if (!e) continue;
      this.inflight.delete(c.req.id);
      this.reply(e, c.outcome, ctx);
    }
  }

  tick(ctx: Ctx): void {
    this.pump(ctx);
    // TCP retransmission of replies the network dropped.
    const ectx = asEngineContext(ctx);
    const keep: typeof this.sentReplies = [];
    for (const s of this.sentReplies) {
      const tr = ectx.trace(s.id);
      if (tr === undefined) {
        if (ctx.now - s.at <= 1) keep.push(s);
        continue;
      }
      if (tr.result === 'dropped' && this.process === 'up') this.resend.push(s.draft);
    }
    this.sentReplies = keep;
  }

  onFail(): void {
    this.clear();
  }

  private reply(e: Inflight, reply: IoReply, ctx: Ctx): void {
    const payload: IoRespPayload = {
      t: 'resp',
      ioId: e.req.id,
      vm: e.req.vm,
      cvm: this.cvm,
      reply,
    };
    const draft: MessageDraft = {
      kind: e.kind,
      src: e.local,
      dst: e.remote,
      // Read data comes back; a write is acknowledged with a small response.
      size: e.req.op === 'read' && reply.status === 'ok' ? e.req.size : 'small',
      flow: e.flow,
      payload,
      causeId: e.req.id,
    };
    this.track(ctx.send(draft), draft, ctx.now);
  }

  private track(id: string, draft: MessageDraft, at: number): void {
    this.sentReplies.push({ id, draft, at });
  }

  private clear(): void {
    this.inflight.clear();
    this.handover.clear();
    this.waiting.clear();
    this.acquired.clear();
    this.toRelease.clear();
    this.resend = [];
    this.sentReplies = [];
  }
}

function reverse(msg: Message, ctx: Ctx): Message['flow'] {
  return asEngineContext(ctx).flow(msg.dst, msg.src, {
    srcPort: msg.flow.dstPort,
    dstPort: msg.flow.srcPort,
  });
}
