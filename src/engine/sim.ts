/**
 * Simulation facade (SPEC §5.2, §5.6). Owns time, devices, network, messaging, timers, events
 * and snapshots. Headless and deterministic: devices run in sorted-id order, randomness comes
 * from the seeded RNG, and nothing reads the wall clock.
 *
 * Tick order: queued actions → preTick → emit → delivery rounds (onMessage) → tick (timers fire
 * first, then bond rebalancing, then device `tick` hooks) → postTick → snapshot.
 * Devices that are down (failed themselves or via an ancestor) skip every hook.
 */
import {
  type ActionDefinition,
  ActionError,
  ActionRegistry,
  type ActionTarget,
  builtinActions,
  isLinkView,
} from './actions';
import { type PendingTimer, TimerQueue } from './clock';
import {
  type DerivedValue,
  type EngineDevice,
  type EngineTickContext,
  type EngineTrace,
  markEngineContext,
  type TickPhase,
} from './context';
import { EventLog } from './events';
import { DEFAULT_DELIVERY_ROUNDS, MessageBus, TrafficRegistry } from './messaging';
import { type NetworkQuery, NetworkRuntime } from './network/runtime';
import { NetworkError, type NetworkSpec } from './network/spec';
import { createRng, type SeededRng } from './rng';
import { buildSnapshot, bumpVersion } from './snapshot';
import type {
  ActionRequest,
  ActionSpec,
  Device,
  DeviceId,
  DeviceStatus,
  DeviceView,
  EventDraft,
  LinkId,
  Message,
  MessageDraft,
  MsgKind,
  SimEvent,
  SimTime,
  Simulation,
  Snapshot,
  TrafficCategory,
  VersionSelection,
} from './types';

export interface SimulationOptions<TProfile = unknown> {
  /** Caller-supplied devices (domain modules). May also implement `DeviceLifecycle`. */
  readonly devices: readonly Device<TProfile>[];
  readonly network?: NetworkSpec;
  readonly profile: TProfile;
  readonly seed: number;
  readonly topologyId: string;
  readonly versions: VersionSelection;
  /** Extra (domain) actions, registered after the built-ins. */
  readonly actions?: readonly ActionDefinition[];
  /** Delivery rounds per tick (SPEC §5.2 phase 4). Default 3. */
  readonly deliveryRounds?: number;
  /** Message kind → traffic category, or a shared registry. */
  readonly traffic?: TrafficRegistry | Readonly<Record<MsgKind, TrafficCategory>>;
}

/** `Simulation` plus read-only engine introspection for tests, the bridge and the inspector. */
export interface EngineSimulation extends Simulation {
  readonly net: NetworkQuery;
  readonly traffic: TrafficRegistry;
  pendingTimers(): readonly PendingTimer[];
  queuedActions(): readonly ActionRequest[];
  /** The event and its transitive causes, oldest first (Explain panel). */
  causalChain(eventId: string): readonly SimEvent[];
  isDown(id: DeviceId): boolean;
}

export function createSimulation<TProfile>(opts: SimulationOptions<TProfile>): EngineSimulation {
  return new Sim(opts);
}

const STATUS_RANK: Readonly<Record<DeviceStatus, number>> = {
  healthy: 0,
  unknown: 1,
  degraded: 2,
  stalled: 3,
  fenced: 4,
  offline: 5,
  failed: 6,
};

class Sim<TProfile> implements EngineSimulation {
  readonly net: NetworkRuntime;
  readonly traffic: TrafficRegistry;
  private readonly devices: readonly EngineDevice<TProfile>[];
  private readonly byId = new Map<DeviceId, EngineDevice<TProfile>>();
  private readonly ctxs = new Map<DeviceId, EngineTickContext<TProfile>>();
  private readonly parents = new Map<string, string>();
  private readonly failed = new Set<string>();
  private readonly rng: SeededRng;
  private readonly log = new EventLog();
  private readonly timers: TimerQueue;
  private readonly bus = new MessageBus();
  private readonly registry: ActionRegistry;
  private readonly rounds: number;
  private readonly listeners = new Set<() => void>();
  private queue: ActionRequest[] = [];
  private traces: EngineTrace[] = [];
  private traceById = new Map<string, EngineTrace>();
  private causeStack: (readonly string[])[] = [];
  private phase: TickPhase = 'init';
  private now: SimTime = 0;
  private version = 0;
  private eventMark = 0;
  private snapshot: Snapshot;

  constructor(private readonly opts: SimulationOptions<TProfile>) {
    this.rounds = opts.deliveryRounds ?? DEFAULT_DELIVERY_ROUNDS;
    if (!Number.isInteger(this.rounds) || this.rounds < 1) {
      throw new RangeError(`deliveryRounds must be an integer >= 1, got ${this.rounds}`);
    }
    this.traffic =
      opts.traffic instanceof TrafficRegistry ? opts.traffic : new TrafficRegistry(opts.traffic);
    this.rng = createRng(opts.seed);
    this.timers = new TimerQueue(() => this.now);

    this.devices = [...opts.devices].sort((a, b) => cmp(a.id, b.id));
    for (const d of this.devices) {
      if (this.byId.has(d.id)) throw new Error(`duplicate device id '${d.id}'`);
      this.byId.set(d.id, d);
      if (d.parentId !== undefined) this.parents.set(d.id, d.parentId);
    }
    const spec = opts.network ?? {};
    for (const el of [...(spec.nics ?? []), ...(spec.bonds ?? []), ...(spec.bridges ?? [])]) {
      if (el.owner !== undefined && !this.parents.has(el.id)) this.parents.set(el.id, el.owner);
    }

    this.net = new NetworkRuntime(spec, {
      now: () => this.now,
      timers: this.timers,
      isDown: (id) => this.isDown(id),
      emit: (d) => this.emitEvent(d),
      causes: () => this.causes(),
      withCauses: (c, fn) => this.withCauses(c, fn),
    });
    this.registry = new ActionRegistry([
      ...builtinActions({ net: this.net, isFailed: (id) => this.failed.has(id) }),
      ...(opts.actions ?? []),
    ]);
    for (const d of this.devices) this.ctxs.set(d.id, this.makeContext(d));
    this.snapshot = this.buildSnapshot();
  }

  // ── Facade ────────────────────────────────────────────────────────────────

  getSnapshot = (): Snapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  applyAction(action: ActionRequest): void {
    this.queue.push(
      Object.freeze({ ...action, ...(action.params ? { params: { ...action.params } } : {}) }),
    );
    this.version++;
    this.snapshot = bumpVersion(this.snapshot, this.version, {
      'engine.queuedActions': this.queue.length,
    });
    this.notify();
  }

  tick(n = 1): Snapshot {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`tick(n): n must be >= 0, got ${n}`);
    for (let i = 0; i < n; i++) this.tickOnce();
    return this.snapshot;
  }

  runUntilNextTimer(maxTicks = 86_400): Snapshot {
    const due = this.timers.nextDueAt();
    if (due === null) return this.snapshot;
    for (let i = 0; i < maxTicks && this.now < due; i++) this.tickOnce();
    return this.snapshot;
  }

  availableActions(target: DeviceId | LinkId): readonly ActionSpec[] {
    const view = this.viewOf(target);
    return view ? this.registry.applicable(view) : [];
  }

  eventLog(): readonly SimEvent[] {
    return this.log.all();
  }

  pendingTimers(): readonly PendingTimer[] {
    return this.timers.pending();
  }

  queuedActions(): readonly ActionRequest[] {
    return [...this.queue];
  }

  causalChain(eventId: string): readonly SimEvent[] {
    return this.log.causalChain(eventId);
  }

  /** The failed device that takes `id` down (itself or its nearest failed ancestor), if any. */
  downCause(id: string): string | undefined {
    const seen = new Set<string>();
    for (let cur: string | undefined = id; cur !== undefined; cur = this.parents.get(cur)) {
      if (this.failed.has(cur)) return cur;
      if (seen.has(cur)) break;
      seen.add(cur);
    }
    return undefined;
  }

  /** True if `id` or any ancestor has been failed. */
  isDown(id: string): boolean {
    const seen = new Set<string>();
    for (let cur: string | undefined = id; cur !== undefined; cur = this.parents.get(cur)) {
      if (this.failed.has(cur)) return true;
      if (seen.has(cur)) break;
      seen.add(cur);
    }
    return false;
  }

  // ── Tick ──────────────────────────────────────────────────────────────────

  private tickOnce(): void {
    this.now++;
    this.eventMark = this.log.size;
    this.traces = [];
    this.traceById = new Map();
    this.net.beginTick();

    this.phase = 'actions';
    const queued = this.queue;
    this.queue = [];
    for (const req of queued) this.applyNow(req);

    this.runHook('preTick', (d, ctx) => d.preTick?.(ctx));
    this.runHook('emit', (d, ctx) => d.emit?.(ctx));

    this.phase = 'deliver';
    this.bus.deliverRounds(this.rounds, (msg) => this.deliver(msg));

    this.phase = 'tick';
    this.timers.fireDue(this.now);
    this.net.tick(this.now);
    this.runHook('tick', (d, ctx) => d.tick?.(ctx));

    this.runHook('postTick', (d, ctx) => d.postTick?.(ctx));

    this.phase = 'snapshot';
    this.version++;
    this.snapshot = this.buildSnapshot();
    this.notify();
  }

  private runHook(
    phase: TickPhase,
    fn: (d: EngineDevice<TProfile>, ctx: EngineTickContext<TProfile>) => void,
  ): void {
    this.phase = phase;
    for (const d of this.devices) {
      if (this.isDown(d.id)) continue;
      fn(d, this.ctx(d.id));
    }
  }

  private deliver(msg: Message): void {
    const r = this.net.route({ src: msg.src, dst: msg.dst, size: msg.size, flow: msg.flow });
    const category = this.traffic.categoryOf(msg.kind);
    const trace: EngineTrace = Object.freeze({
      msgId: msg.id,
      kind: msg.kind,
      category,
      round: msg.round,
      links: Object.freeze([...r.links]),
      result: r.delivered ? 'delivered' : 'dropped',
      ...(r.dropAt === undefined ? {} : { dropAt: r.dropAt }),
      ...(r.reason === undefined ? {} : { reason: r.reason }),
      src: msg.src,
      dst: msg.dst,
      latencyMs: r.latencyMs,
      ...(r.detail === undefined ? {} : { detail: r.detail }),
      ...(r.egress === undefined ? {} : { egress: r.egress }),
    });
    this.traces.push(trace);
    this.traceById.set(msg.id, trace);
    this.net.recordUtil(r.carried, category);
    if (!r.delivered) return;
    const owner = this.net.endpoint(msg.dst)?.owner;
    const dev = owner === undefined ? undefined : this.byId.get(owner);
    if (dev?.onMessage && !this.isDown(dev.id)) dev.onMessage(msg, this.ctx(dev.id));
  }

  // ── Actions and failures ──────────────────────────────────────────────────

  private applyNow(req: ActionRequest): void {
    const def = this.registry.get(req.kind);
    const target = this.viewOf(req.target);
    const reject = (why: string, causeIds: readonly string[] = []) =>
      this.emitEvent({
        severity: 'warn',
        ...(target && !isLinkView(target) ? { deviceId: target.id } : {}),
        code: 'action.rejected',
        text: `${req.kind} on ${req.target}: ${why}`,
        causeIds,
        cite: [],
      });
    if (!def) return void reject('unknown action');
    if (!target) return void reject('unknown target');
    if (!def.spec.appliesTo(target)) return void reject('not applicable to this target');

    const params = Object.entries(req.params ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    const ev = this.emitEvent({
      severity: 'info',
      ...(isLinkView(target) ? {} : { deviceId: target.id }),
      code: `action.${req.kind}`,
      text: `${def.spec.label}: ${target.id}${params ? ` (${params})` : ''}`,
      causeIds: [],
      cite: [],
    });
    try {
      this.withCauses([ev], () =>
        def.apply(req, {
          now: this.now,
          causeIds: [ev],
          net: this.net,
          failDevice: (id) => this.failDevice(id),
          recoverDevice: (id) => this.recoverDevice(id),
          isFailed: (id) => this.failed.has(id),
          emit: (d) => this.emitEvent(d),
        }),
      );
    } catch (err) {
      if (err instanceof ActionError || err instanceof NetworkError) reject(err.message, [ev]);
      else throw err;
    }
  }

  private knownId(id: string): boolean {
    const k = this.net.kindOf(id);
    return this.byId.has(id) || k === 'nic' || k === 'switch' || k === 'bond' || k === 'bridge';
  }

  private failDevice(id: DeviceId): void {
    if (!this.knownId(id)) throw new ActionError(`unknown device '${id}'`);
    if (this.failed.has(id)) return;
    const wasDown = new Set(this.devices.filter((d) => this.isDown(d.id)).map((d) => d.id));
    this.failed.add(id);
    const ev = this.emitEvent({
      severity: 'error',
      deviceId: id,
      code: 'device.failed',
      text: `${this.labelOf(id)} failed`,
      causeIds: this.causes(),
      cite: [],
    });
    this.withCauses([ev], () => {
      for (const d of this.devices) {
        if (wasDown.has(d.id) || !this.isDown(d.id)) continue;
        d.onFail?.(this.ctx(d.id));
      }
      this.timers.cancelWhere((owner) => this.isDown(owner));
      this.net.reconcile();
    });
  }

  private recoverDevice(id: DeviceId): void {
    if (!this.failed.has(id)) throw new ActionError(`'${id}' is not failed`);
    const wasDown = new Set(this.devices.filter((d) => this.isDown(d.id)).map((d) => d.id));
    this.failed.delete(id);
    const ev = this.emitEvent({
      severity: 'info',
      deviceId: id,
      code: 'device.recovered',
      text: `${this.labelOf(id)} recovered`,
      causeIds: this.causes(),
      cite: [],
    });
    this.withCauses([ev], () => {
      for (const d of this.devices) {
        if (!wasDown.has(d.id) || this.isDown(d.id)) continue;
        d.onRecover?.(this.ctx(d.id));
      }
      this.net.reconcile();
    });
  }

  // ── Events and causes ─────────────────────────────────────────────────────

  private emitEvent(draft: EventDraft): string {
    return this.log.append(this.now, draft);
  }

  private causes(): readonly string[] {
    return this.causeStack[this.causeStack.length - 1] ?? [];
  }

  private withCauses(causes: readonly string[], fn: () => void): void {
    this.causeStack.push(causes);
    try {
      fn();
    } finally {
      this.causeStack.pop();
    }
  }

  // ── Contexts ──────────────────────────────────────────────────────────────

  private ctx(id: DeviceId): EngineTickContext<TProfile> {
    const c = this.ctxs.get(id);
    if (!c) throw new Error(`no context for device '${id}'`);
    return c;
  }

  private makeContext(d: EngineDevice<TProfile>): EngineTickContext<TProfile> {
    const sim = this;
    const ctx: EngineTickContext<TProfile> = {
      get now() {
        return sim.now;
      },
      rng: this.rng.fork(d.id),
      profile: this.opts.profile,
      get prev() {
        return sim.snapshot;
      },
      timers: this.timers.api(d.id),
      send<P>(draft: MessageDraft<P>): string {
        return sim.bus.send(draft, sim.now).id;
      },
      emit(event: EventDraft): string {
        return sim.emitEvent(event.deviceId === undefined ? { ...event, deviceId: d.id } : event);
      },
      self: d.id,
      get phase() {
        return sim.phase;
      },
      isUp: (id) => !this.isDown(id),
      net: this.net,
      endpoints: {
        setUp: (id, up, causeIds = []) =>
          this.withCauses(causeIds, () => this.net.setEndpointUp(id, up)),
        setFenced: (id, fenced, causeIds = []) =>
          this.withCauses(causeIds, () => this.net.setEndpointFenced(id, fenced)),
        move: (id, attach, causeIds = []) => {
          let ev = '';
          this.withCauses(causeIds, () => {
            ev = this.net.moveEndpoint(id, attach);
          });
          return ev;
        },
      },
      flow: (src, dst, l4) => this.net.flow(src, dst, l4),
      trace: (msgId) => this.traceById.get(msgId),
    };
    return markEngineContext(ctx);
  }

  // ── Views and snapshots ───────────────────────────────────────────────────

  private labelOf(id: string): string {
    return this.byId.get(id)?.label ?? id;
  }

  private deviceViews(): DeviceView[] {
    const netViews = new Map(this.net.elementViews().map((v) => [v.id, v] as const));
    const ids = [...new Set([...this.byId.keys(), ...netViews.keys()])].sort(cmp);
    return ids.map((id) => {
      const dev = this.byId.get(id);
      const nv = netViews.get(id);
      let v: DeviceView;
      if (dev) {
        const dv = dev.view();
        if (dv.id !== id) throw new Error(`device '${id}' returned a view for '${dv.id}'`);
        v = nv
          ? {
              ...dv,
              status: worst(dv.status, nv.status),
              fields: { ...nv.fields, ...dv.fields },
            }
          : dv;
      } else {
        v = nv as DeviceView;
      }
      // A failure propagates to everything under the failed device (NICs, vswitches, CVM, VMs…):
      // status `failed`, plus why, so views never look healthy under a dead parent.
      const cause = this.downCause(id);
      if (cause === undefined) return v;
      const downReason = cause === id ? 'failed' : `${cause} failed`;
      return { ...v, status: 'failed', fields: { ...v.fields, down: true, downReason } };
    });
  }

  private viewOf(id: string): ActionTarget | undefined {
    return (
      this.deviceViews().find((v) => v.id === id) ?? this.net.linkViews().find((l) => l.id === id)
    );
  }

  private buildSnapshot(): Snapshot {
    const derived: Record<string, DerivedValue> = {};
    for (const d of this.devices) Object.assign(derived, d.derived?.() ?? {});
    derived['engine.queuedActions'] = this.queue.length;
    return buildSnapshot({
      version: this.version,
      simTime: this.now,
      seed: this.rng.seed,
      topologyId: this.opts.topologyId,
      versions: this.opts.versions,
      devices: this.deviceViews(),
      // A cable is down when the device at either end is down (its carrier is gone).
      links: this.net
        .linkViews()
        .map((l) =>
          l.status === 'up' && (this.isDown(l.a.device) || this.isDown(l.b.device))
            ? { ...l, status: 'down' as const }
            : l,
        ),
      traces: this.traces,
      events: this.log.since(this.eventMark),
      derived,
      nextTimerAt: this.timers.nextDueAt(),
    });
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }
}

function worst(a: DeviceStatus, b: DeviceStatus): DeviceStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
