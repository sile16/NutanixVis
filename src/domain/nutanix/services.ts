/**
 * Small per-CVM service components (contract `CvmComponent`):
 * - `ZkMember`: Zookeeper session/ensemble traffic. Every CVM pings every other CVM's inter-CVM
 *   endpoint each tick; who answered feeds the cluster's partition / quorum computation.
 * - `CassandraNode`: this CVM's metadata-ring membership (`normal | down | detached`), driven by
 *   the cluster device (auto ring-repair, Bible 4i / KB-1256).
 * - `AcropolisWorker`: on the Acropolis leader's CVM it polls every host's libvirtd at
 *   `ahvHa.heartbeatIntervalS` (Bible 5b) and records the replies.
 */

import { asEngineContext } from '../../engine/context';
import type { Message } from '../../engine/types';
import type { Ctx, CvmComponent } from '../contracts';
import { MSG, type PingPayload, PORT, portFor } from './messages';
import type { Registry } from './registry';

export class ZkMember implements CvmComponent {
  readonly name = 'zookeeper';
  /** CVMs that answered our ping this tick. */
  readonly heard = new Set<string>();

  constructor(
    private readonly cvm: string,
    private readonly reg: Registry,
  ) {}

  preTick(): void {
    this.heard.clear();
  }

  emit(ctx: Ctx): void {
    const ectx = asEngineContext(ctx);
    const src = this.reg.cvmDataEndpoint(this.cvm);
    for (const peer of this.reg.cvmIds()) {
      if (peer === this.cvm) continue;
      const dst = this.reg.cvmDataEndpoint(peer);
      const payload: PingPayload = { t: 'req', from: this.cvm };
      ctx.send({
        kind: MSG.zk,
        src,
        dst,
        size: 'small',
        flow: ectx.flow(src, dst, { srcPort: portFor(`${this.cvm}~zk`), dstPort: PORT.zk }),
        payload,
      });
    }
  }

  onMessage(msg: Message, ctx: Ctx): boolean {
    if (msg.kind !== MSG.zk) return false;
    const p = msg.payload as PingPayload;
    if (p.t === 'resp') {
      this.heard.add(p.from);
      return true;
    }
    const reply: PingPayload = { t: 'resp', from: this.cvm };
    ctx.send({
      kind: MSG.zk,
      src: msg.dst,
      dst: msg.src,
      size: 'small',
      flow: asEngineContext(ctx).flow(msg.dst, msg.src, {
        srcPort: msg.flow.dstPort,
        dstPort: msg.flow.srcPort,
      }),
      payload: reply,
    });
    return true;
  }

  onFail(): void {
    this.heard.clear();
  }
}

export type RingState = 'normal' | 'down' | 'detached';

export class CassandraNode implements CvmComponent {
  readonly name = 'cassandra';
  state: RingState = 'normal';
  downSince: number | null = null;
  stableSince: number | null = null;
}

export class AcropolisWorker implements CvmComponent {
  readonly name = 'acropolis';
  private lastPollAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly cvm: string,
    private readonly host: string,
    private readonly reg: Registry,
  ) {}

  emit(ctx: Ctx): void {
    if (this.reg.leaderCvm() !== this.cvm || !this.reg.leaderActive()) return;
    const interval = ctx.profile.ahvHa.heartbeatIntervalS.value;
    if (ctx.now - this.lastPollAt < interval) return;
    this.lastPollAt = ctx.now;
    const ectx = asEngineContext(ctx);
    const me = this.reg.facts.cvm(this.cvm);
    if (!me) return;
    for (const h of this.reg.facts.hosts) {
      // The leader's own host is reached over virbr0; the others on their mgmt IP.
      const local = h.id === this.host;
      const src = local ? me.internalEndpoint : me.mgmtEndpoint;
      const dst = local ? h.internalEndpoint : h.mgmtEndpoint;
      if (dst === null) continue;
      const payload: PingPayload = { t: 'req', from: this.cvm };
      ctx.send({
        kind: MSG.haPoll,
        src,
        dst,
        size: 'small',
        flow: ectx.flow(src, dst, {
          srcPort: portFor(`${this.cvm}~${h.id}~ha`),
          dstPort: PORT.libvirt,
        }),
        payload,
      });
    }
  }

  onMessage(msg: Message, ctx: Ctx): boolean {
    if (msg.kind !== MSG.haPoll) return false;
    const p = msg.payload as PingPayload;
    if (p.t === 'resp' && this.reg.leaderCvm() === this.cvm)
      this.reg.lastHeard.set(p.from, ctx.now);
    return true;
  }
}
