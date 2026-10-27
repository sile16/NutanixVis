/**
 * AHV host (SPEC §6.2, §6.3a). Owns power, the iSCSI redirector and the libvirtd endpoint the
 * Acropolis leader polls. `haState` is the leader's view of it (registry). The host is the
 * endpoint owner of its virbr0 address and its mgmt `host-interface`, so it receives NOP replies,
 * HA polls and the IO replies it forwards to its VMs.
 */

import { asEngineContext } from '../../engine/context';
import type { Device, DeviceStatus, DeviceView, Message, ViewField } from '../../engine/types';
import type { Ctx } from '../contracts';
import type { Profile } from '../versions/profile';
import type { HostFacts } from './facts';
import { type IoPayload, isIoKind, MSG, type PingPayload } from './messages';
import { Redirector } from './redirector';
import type { Registry } from './registry';

export class AhvHost implements Device<Profile> {
  readonly kind = 'ahv-host';
  readonly id: string;
  readonly label: string;
  readonly redirector: Redirector;
  private engineUp = true;
  private rebooting = false;
  private rebootRequested = false;
  /** Links `host.isolate` took down (restored by `host.unisolate`). */
  isolatedLinks: readonly string[] = [];

  constructor(
    readonly facts: HostFacts,
    private readonly reg: Registry,
  ) {
    this.id = facts.id;
    this.label = facts.label;
    this.redirector = new Redirector(facts, reg);
  }

  alive(): boolean {
    return this.engineUp && !this.rebooting;
  }

  requestReboot(): void {
    this.rebootRequested = true;
  }

  preTick(ctx: Ctx): void {
    this.reg.now = ctx.now;
    if (this.rebootRequested) {
      this.rebootRequested = false;
      if (this.alive()) this.startReboot(ctx);
    }
  }

  emit(ctx: Ctx): void {
    if (!this.alive()) return;
    this.redirector.emit(ctx);
  }

  onMessage(msg: Message, ctx: Ctx): void {
    if (!this.alive()) return;
    if (msg.kind === MSG.nop) {
      const p = msg.payload as PingPayload;
      if (p.t === 'resp') this.redirector.onNopReply(p.from);
      return;
    }
    if (msg.kind === MSG.haPoll) {
      const p = msg.payload as PingPayload;
      if (p.t !== 'req') return;
      // libvirtd answers the Acropolis leader's heartbeat (Bible 5b).
      const reply: PingPayload = { t: 'resp', from: this.id };
      ctx.send({
        kind: MSG.haPoll,
        src: msg.dst,
        dst: msg.src,
        size: 'small',
        flow: asEngineContext(ctx).flow(msg.dst, msg.src, {
          srcPort: msg.flow.dstPort,
          dstPort: msg.flow.srcPort,
        }),
        payload: reply,
      });
      return;
    }
    if (isIoKind(msg.kind)) {
      const p = msg.payload as IoPayload;
      if (p.t !== 'resp') return;
      this.reg.vms.get(p.vm)?.onReply(p.ioId, p.reply, msg.id, ctx);
    }
  }

  tick(ctx: Ctx): void {
    if (!this.alive()) return;
    this.redirector.tick(ctx);
  }

  onFail(): void {
    this.engineUp = false;
    this.rebooting = false;
    this.redirector.reset();
  }

  onRecover(): void {
    this.engineUp = true;
  }

  view(): DeviceView {
    const ha = this.reg.haOf(this.id);
    const fields: Record<string, ViewField> = {
      power: this.alive() ? 'on' : 'off',
      role: this.facts.role,
      haState: ha.state,
      block: this.facts.block,
      cvm: this.facts.cvm,
      rebooting: this.rebooting,
      isolated: this.isolatedLinks.length > 0,
      sessions: JSON.stringify(this.redirector.sessionsView()),
      unhealthyStargates: JSON.stringify(this.redirector.unhealthyView()),
      heartbeatLostAt: ha.lostAt,
    };
    const badges: string[] = [];
    if (this.reg.leaderHost === this.id) badges.push('acropolis-leader');
    let status: DeviceStatus = 'healthy';
    if (!this.alive()) status = 'offline';
    else if (ha.state === 'fenced') status = 'fenced';
    else if (ha.state === 'disconnected' || this.isolatedLinks.length > 0) status = 'degraded';
    return { id: this.id, kind: this.kind, label: this.label, status, badges, fields };
  }

  /**
   * Internal power cycle: endpoints go away and VMs/CVM see the host down; after
   * `hostRebootS` (assumption) the host is back and its CVM starts booting.
   */
  private startReboot(ctx: Ctx): void {
    const A = ctx.profile.cluster.hostRebootS;
    this.rebooting = true;
    this.redirector.reset();
    const ends = this.ownEndpoints();
    const ectx = asEngineContext(ctx);
    for (const e of ends) ectx.endpoints.setUp(e, false);
    ctx.timers.set(
      `${this.id} reboot`,
      A.value,
      { cite: [...A.cite], confidence: A.confidence },
      () => {
        this.rebooting = false;
        for (const e of ends) ectx.endpoints.setUp(e, true);
        ctx.emit({
          severity: 'info',
          deviceId: this.id,
          code: 'host.boot.complete',
          text: `${this.label} is back after a reboot`,
          causeIds: [],
          cite: [...A.cite],
          confidence: A.confidence,
        });
      },
    );
  }

  private ownEndpoints(): string[] {
    return [this.facts.internalEndpoint, this.facts.mgmtEndpoint].filter(
      (e): e is string => e !== null,
    );
  }
}
