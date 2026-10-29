/**
 * FlashArray devices (SPEC §6.4): the `fa-array` (Purity HA logic, held-IO release, interface
 * state), the two `fa-controller`s (NVMe/TCP target on their ports) and one view-only device per
 * `fa-interface` (docs/view-fields.md). All state lives in the shared `FlashArrayModel`.
 */
import { asEngineContext, type EngineDevice, type EngineTickContext } from '../../engine/context';
import type { DeviceStatus, DeviceView, Message, TickContext, ViewField } from '../../engine/types';
import type { KnownCitationId } from '../citations';
import type { CauseIndex } from '../nvme-tcp/causes';
import {
  type AdminPayload,
  type CommandPayload,
  type ConnectRespPayload,
  NVME_MSG,
  type ReplyDraft,
  type ResetPayload,
} from '../nvme-tcp/protocol';
import type { Profile } from '../versions/profile';
import type { FaFacts, FaInterfaceFact } from './facts';
import type { FaEnv, FlashArrayModel } from './model';

type Ctx = TickContext<Profile>;
type ECtx = EngineTickContext<Profile>;

export function deviceEnv(ctx: ECtx): FaEnv {
  return {
    now: ctx.now,
    emit: (e) => ctx.emit(e),
    setEndpointUp: (id, up, causes) => ctx.endpoints.setUp(id, up, causes),
    moveEndpoint: (id, nic, causes) => {
      ctx.endpoints.move(id, { kind: 'nic', id: nic }, causes);
    },
  };
}

export function replySender(ctx: ECtx): <P>(d: ReplyDraft<P>) => string {
  return <P>(d: ReplyDraft<P>) => {
    const { srcPort, dstPort, ...rest } = d;
    return ctx.send({ ...rest, flow: ctx.flow(d.src, d.dst, { srcPort, dstPort }) });
  };
}

/**
 * Everpure: "Do not enable Priority Flow Control (PFC) or Global Pause … not supported by Everpure
 * FlashArray in NVMe/TCP environments" (NET). Flagged once, on the first tick any of this
 * domain's devices runs.
 */
export function warnFlowControl(model: FlashArrayModel, ctx: Ctx): void {
  if (model.configWarned) return;
  model.configWarned = true;
  for (const sw of model.facts.switches) {
    if (sw.flowControl === 'off') continue;
    ctx.emit({
      severity: 'warn',
      deviceId: sw.id,
      code: 'switch.flow-control.unsupported',
      text: `${sw.id}: flow control '${sw.flowControl}' is not supported for FlashArray NVMe/TCP; disable PFC and global pause`,
      causeIds: [],
      cite: ['everpure-nutanix-net-bp'] satisfies KnownCitationId[],
      confidence: 'verified',
    });
  }
}

function view(
  id: string,
  kind: string,
  label: string,
  parent: string | undefined,
  status: DeviceStatus,
  badges: readonly string[],
  fields: Record<string, ViewField>,
): DeviceView {
  return { id, kind, label, ...(parent === undefined ? {} : { parent }), status, badges, fields };
}

export class FaArrayDevice implements EngineDevice<Profile> {
  readonly kind = 'fa-array';
  readonly id: string;
  readonly label: string;
  /** NIC → carrier (NIC up and its cable up), refreshed every tick. */
  private readonly carrier = new Map<string, boolean>();

  constructor(
    private readonly model: FlashArrayModel,
    private readonly causes: CauseIndex,
  ) {
    this.id = model.facts.array.id;
    this.label = model.facts.array.label;
  }

  preTick(c: Ctx): void {
    const ctx = asEngineContext(c);
    this.model.observe(ctx.now);
    this.causes.observe(ctx.prev);
    warnFlowControl(this.model, ctx);
    this.model.step(
      deviceEnv(ctx),
      (id) => ctx.isUp(id),
      (id) => this.causes.causeOf(id),
    );
  }

  emit(c: Ctx): void {
    const ctx = asEngineContext(c);
    const send = replySender(ctx);
    this.model.flush(send);
    this.model.retransmit(send);
  }

  tick(c: Ctx): void {
    const ctx = asEngineContext(c);
    this.model.inspectResponses((msgId, sentAt) => {
      const t = ctx.trace(msgId);
      if (!t) return ctx.now - sentAt > 1 ? 'dropped' : 'pending';
      return t.result === 'delivered' ? 'delivered' : 'dropped';
    });
    const f = this.model.facts;
    // A data port that loses link drops its NVMe/TCP connections (`assumption`): frames of the
    // old associations get a TCP reset once the port is back (SPEC §6.4c "Short port flap").
    for (const i of f.interfaces) {
      if (i.service !== 'nvme-tcp' || i.floating) continue;
      const link = f.linkOfNic.get(i.nic);
      const up = link !== undefined && ctx.net.link(link)?.status === 'up' && ctx.isUp(i.nic);
      if (this.carrier.get(i.nic) !== false && !up) {
        const n = this.model.tearDown(i.id);
        if (n > 0) {
          ctx.emit({
            severity: 'debug',
            deviceId: i.id,
            code: 'fa.port.connections-dropped',
            text: `${i.id}: port lost link; the target drops its ${n} NVMe/TCP connection(s)`,
            causeIds: this.causes.causeOf(i.nic, link),
            cite: this.model.profile.externalStorage.targetResetRetryS.cite,
            confidence: 'assumption',
          });
        }
      }
    }
    const nics = new Set([
      ...f.interfaces.map((i) => i.nic),
      ...f.controllers.flatMap((c) => (c.mgmtNic === null ? [] : [c.mgmtNic])),
    ]);
    for (const nic of nics) {
      const link = f.linkOfNic.get(nic);
      const up = link !== undefined && ctx.net.link(link)?.status === 'up';
      this.carrier.set(nic, ctx.isUp(nic) && up);
    }
  }

  onRecover(): void {
    this.model.coldBoot = true;
  }

  carrierOf(nic: string): boolean {
    return this.carrier.get(nic) ?? true;
  }

  view(): DeviceView {
    const m = this.model;
    const primary = m.primary();
    const serving = m.serving();
    const down = m.controllers.filter((c) => c.state !== 'up');
    const promoting = m.controllers.find((c) => c.role === 'promoting');
    const status: DeviceStatus = !serving ? 'stalled' : down.length > 0 ? 'degraded' : 'healthy';
    return view(this.id, this.kind, this.label, undefined, status, serving ? [] : ['io-paused'], {
      model: m.facts.array.model,
      ioServing: serving,
      pauseS: m.pauseS(),
      primary: primary?.id ?? null,
      promoting: promoting?.id ?? null,
      mgmtApi: m.mgmtApi(),
      ndu: m.nduPhase(),
      heldIo: m.heldCount(),
      reservations: m.reservations.size,
      promotionS: m.promotionS,
    });
  }
}

export class FaControllerDevice implements EngineDevice<Profile> {
  readonly kind = 'fa-controller';
  readonly label: string;
  readonly parentId: string;

  constructor(
    readonly id: string,
    private readonly model: FlashArrayModel,
  ) {
    const c = model.requireController(id);
    this.label = c.label;
    this.parentId = model.facts.array.id;
  }

  onMessage(msg: Message, c: Ctx): void {
    const ctx = asEngineContext(c);
    const m = this.model;
    m.observe(ctx.now);
    const ctrl = m.controller(this.id);
    if (!ctrl || (ctrl.state !== 'up' && ctrl.state !== 'stalled')) return;
    if (!this.admitted(msg, ctx)) return;
    switch (msg.kind) {
      case NVME_MSG.connect:
      case NVME_MSG.keepAlive: {
        // Admin queue is answered even while the array pauses IO (the target is alive).
        m.noteHost(this.id, msg.src, ctx.now);
        const pl = msg.payload as AdminPayload;
        replySender(ctx)<AdminPayload | ConnectRespPayload>({
          kind: msg.kind === NVME_MSG.connect ? NVME_MSG.connectResp : NVME_MSG.keepAliveResp,
          src: msg.dst,
          dst: msg.src,
          size: 'small',
          srcPort: msg.flow.dstPort,
          dstPort: msg.flow.srcPort,
          payload: msg.kind === NVME_MSG.connect ? { ...pl, ok: true } : pl,
        });
        return;
      }
      case NVME_MSG.io:
      case NVME_MSG.resv:
        m.receive(
          this.id,
          msg as Message<CommandPayload>,
          ctx.trace(msg.id)?.latencyMs ?? 0,
          replySender(ctx),
        );
        return;
      default:
        return;
    }
  }

  /** Association check; a frame of a torn-down association gets a TCP reset instead. */
  private admitted(msg: Message, ctx: ECtx): boolean {
    const nvme: readonly string[] = [
      NVME_MSG.connect,
      NVME_MSG.keepAlive,
      NVME_MSG.io,
      NVME_MSG.resv,
    ];
    if (!nvme.includes(msg.kind)) return true;
    const gen = (msg.payload as { readonly gen?: number }).gen ?? 0;
    const host = (msg.payload as { readonly host?: string }).host ?? '';
    if (this.model.admit(msg.dst, msg.src, gen, msg.kind === NVME_MSG.connect)) return true;
    replySender(ctx)<ResetPayload>({
      kind: NVME_MSG.reset,
      src: msg.dst,
      dst: msg.src,
      size: 'small',
      srcPort: msg.flow.dstPort,
      dstPort: msg.flow.srcPort,
      payload: { host, gen },
    });
    return false;
  }

  onFail(): void {
    this.model.crash(this.id);
  }

  onRecover(c: Ctx): void {
    this.model.recover(this.id, deviceEnv(asEngineContext(c)));
  }

  view(): DeviceView {
    const c = this.model.requireController(this.id);
    const status: DeviceStatus =
      c.state === 'crashed'
        ? 'failed'
        : c.state === 'rebooting'
          ? 'offline'
          : c.state === 'stalled'
            ? 'stalled'
            : c.role === 'promoting'
              ? 'degraded'
              : 'healthy';
    return view(
      this.id,
      this.kind,
      this.label,
      this.parentId,
      status,
      c.role === 'primary' ? ['fa-primary'] : [],
      {
        slot: c.slot,
        role: c.role,
        state: c.state,
        rebootUntil: c.rebootUntil,
        hosts: c.hosts.size,
      },
    );
  }
}

/** View-only: one per FA IP (data, mgmt, or the floating VIP). */
export class FaInterfaceDevice implements EngineDevice<Profile> {
  readonly kind = 'fa-interface';
  readonly id: string;
  readonly label: string;
  readonly parentId: string;

  constructor(
    private readonly fact: FaInterfaceFact,
    private readonly model: FlashArrayModel,
    private readonly array: FaArrayDevice,
  ) {
    this.id = fact.id;
    this.label = fact.label;
    this.parentId = fact.parent;
  }

  view(): DeviceView {
    const m = this.model;
    const nic = this.fact.floating ? (m.vipNic ?? this.fact.nic) : this.fact.nic;
    const ctrl = this.fact.floating
      ? m.controllers.find((c) => c.mgmtNic === nic)
      : m.controllerOf(this.id);
    const enabled = m.enabled.get(this.id) ?? true;
    const ctrlUp = ctrl === undefined || ctrl.state === 'up' || ctrl.state === 'stalled';
    const oper = enabled && ctrlUp && this.array.carrierOf(nic) ? 'up' : 'down';
    const status: DeviceStatus = !enabled ? 'offline' : oper === 'up' ? 'healthy' : 'failed';
    return view(this.id, this.kind, this.label, this.parentId, status, [], {
      nic,
      vlan: this.fact.vlan,
      ip: this.fact.ip,
      service: this.fact.service,
      floating: this.fact.floating,
      enabled,
      oper,
    });
  }
}

export function faDevices(
  facts: FaFacts,
  model: FlashArrayModel,
  causes: CauseIndex,
): EngineDevice<Profile>[] {
  const array = new FaArrayDevice(model, causes);
  return [
    array,
    ...facts.controllers.map((c) => new FaControllerDevice(c.id, model)),
    ...facts.interfaces.map((i) => new FaInterfaceDevice(i, model, array)),
  ];
}
