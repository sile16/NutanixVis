/**
 * Stargate (SPEC §6.2): serves vDisk IO from hosts' iSCSI sessions through the CVM's
 * `StorageBackend` (E's NVMe initiator in T1, G's extent store in T2/T3), answers redirector
 * NOPs, and owns vDisks via `backend.acquire` (T1: the NVMe Persistent Reservation, Bible 8c).
 *
 * - IO from a host AHV HA has fenced is refused (Bible 5b: "Stargates block IO from that host").
 * - Without ZK quorum the Stargate is `unhealthy`: it still answers NOPs and serves reads, but
 *   refuses writes, which need quorum-backed metadata (`inferred`; this is also what makes VM
 *   writes fail on an isolated host, Bible 5b / SPEC §6.4a "Host network isolation").
 * - Replies dropped on the wire are retransmitted (TCP) while the Stargate is serving.
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
    if (io.op === 'write' && !this.reg.inQuorum(this.cvm)) {
      this.reply(entry, { status: 'retry', reason: 'no Zookeeper quorum' }, ctx);
      return true;
    }
    if (this.inflight.has(io.id)) {
      this.inflight.set(io.id, entry);
      return true;
    }
    if (!this.acquired.has(io.vdisk)) {
      this.backend.acquire(io.vdisk, ctx);
      this.acquired.add(io.vdisk);
      this.toRelease.delete(io.vdisk);
      this.reg.setOwner(io.vdisk, this.cvm);
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
