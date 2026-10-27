/**
 * Engine contract — the shared types every workstream codes against (SPEC §5, §13.1).
 *
 * Rules:
 * - This file is owned by the integrator. Streams request changes; they don't edit it.
 * - Nothing here may import from `domain/`, `ui/`, `topologies/` or React.
 * - Everything a renderer reads is plain, serializable, frozen data (`Snapshot`).
 */

// ── Identifiers ──────────────────────────────────────────────────────────────

export type DeviceId = string;
export type PortId = string;
export type LinkId = string;
export type EndpointId = string;
export type CitationId = string;
/** Open union: domain modules register their own kinds (e.g. 'nvme-io', 'iscsi-nop'). */
export type MsgKind = string;
/** Open union: domain modules register their own kinds (e.g. 'fa.controller.failover'). */
export type ActionKind = string;

/** Simulated seconds since the scenario started. 1 tick = 1 simulated second (SPEC §5.1). */
export type SimTime = number;

// ── Accuracy metadata (SPEC §2) ──────────────────────────────────────────────

export type Confidence = 'verified' | 'inferred' | 'unverified' | 'assumption' | 'lab-observed';

/** A modeled value plus where it comes from. Every timer/threshold in a profile is `Cited`. */
export interface Cited<T> {
  readonly value: T;
  readonly cite: readonly CitationId[];
  readonly confidence: Confidence;
  readonly note?: string;
}

// ── Messages & traces (SPEC §5.4) ────────────────────────────────────────────

/** Flow identity — bonds select a member link from this (SPEC §5.3). */
export interface FlowId {
  readonly srcMac: string;
  readonly vlan: number;
  readonly srcIp: string;
  readonly dstIp: string;
  readonly srcPort: number;
  readonly dstPort: number;
  readonly proto: 'tcp' | 'udp' | 'internal';
}

/** Size class: `large` frames are dropped on links whose MTU is below the endpoint MTU. */
export type MsgSize = 'small' | 'large';

export interface Message<P = unknown> {
  readonly id: string;
  readonly kind: MsgKind;
  readonly src: EndpointId;
  readonly dst: EndpointId;
  readonly size: MsgSize;
  readonly flow: FlowId;
  readonly payload: P;
  readonly causeId?: string;
  readonly sentAt: SimTime;
  /** Delivery round within the tick (SPEC §5.2 phase 4). */
  readonly round: number;
}

export type MessageDraft<P = unknown> = Omit<Message<P>, 'id' | 'sentAt' | 'round'>;

export type DropReason =
  | 'link-down'
  | 'port-down'
  | 'device-down'
  | 'endpoint-down'
  | 'vlan-not-carried'
  | 'mtu'
  | 'no-route'
  | 'bond-no-member'
  | 'fenced';

/** Category used for packet color/legend in the UI (registered by domain modules). */
export type TrafficCategory = string;

export interface Trace {
  readonly msgId: string;
  readonly kind: MsgKind;
  readonly category: TrafficCategory;
  readonly round: number;
  /** Links traversed in order, including the one it was dropped on (if any). */
  readonly links: readonly LinkId[];
  readonly result: 'delivered' | 'dropped';
  readonly dropAt?: LinkId | DeviceId;
  readonly reason?: DropReason;
}

// ── Events (SPEC §5.6) ───────────────────────────────────────────────────────

export type Severity = 'debug' | 'info' | 'warn' | 'error' | 'critical';

export interface SimEvent {
  readonly seq: number;
  readonly t: SimTime;
  readonly severity: Severity;
  readonly deviceId?: DeviceId;
  /** Stable machine code, e.g. 'nvme.path.lost'. Golden tests compare these. */
  readonly code: string;
  readonly text: string;
  /** Events that caused this one (causal chain for the Explain panel). */
  readonly causeIds: readonly string[];
  readonly cite: readonly CitationId[];
  readonly confidence?: Confidence;
}

export type EventDraft = Omit<SimEvent, 'seq' | 't'>;

// ── Views (what the renderer and tests read) ─────────────────────────────────

export type DeviceStatus =
  | 'healthy'
  | 'degraded'
  | 'stalled'
  | 'failed'
  | 'fenced'
  | 'offline'
  | 'unknown';

export type ViewField = string | number | boolean | null;

export interface DeviceView {
  readonly id: DeviceId;
  /** Topology device kind, e.g. 'ahv-host', 'cvm', 'fa-controller', 'switch'. */
  readonly kind: string;
  readonly label: string;
  readonly parent?: DeviceId;
  readonly status: DeviceStatus;
  /** Short role markers: 'zk-leader', 'acropolis-leader', 'fa-primary', … */
  readonly badges: readonly string[];
  /** Inspector key/values; domain-specific. */
  readonly fields: Readonly<Record<string, ViewField>>;
}

export interface PortRef {
  readonly device: DeviceId;
  readonly port: PortId;
}

export interface LinkView {
  readonly id: LinkId;
  readonly a: PortRef;
  readonly b: PortRef;
  readonly status: 'up' | 'down';
  readonly mtu: number;
  readonly latencyMs: number;
  /** Delivered messages per traffic category during the last tick. */
  readonly util: Readonly<Record<TrafficCategory, number>>;
}

export interface VersionSelection {
  readonly nutanix: string;
  readonly flasharray?: string;
  readonly profileId: string;
}

export interface Snapshot {
  readonly version: number;
  readonly simTime: SimTime;
  readonly seed: number;
  readonly topologyId: string;
  readonly versions: VersionSelection;
  readonly devices: Readonly<Record<DeviceId, DeviceView>>;
  readonly links: Readonly<Record<LinkId, LinkView>>;
  /** Traces produced during the last tick (the UI replays these as packet animation). */
  readonly traces: readonly Trace[];
  /** Events emitted during the last tick. The full log is `Simulation.eventLog()`. */
  readonly events: readonly SimEvent[];
  /** Cluster-level derived state (quorum, resiliency, HA status, …), domain-defined. */
  readonly derived: Readonly<Record<string, ViewField | Readonly<Record<string, ViewField>>>>;
  /** Soonest pending timer, for "fast-forward to next timer". */
  readonly nextTimerAt: SimTime | null;
}

// ── Runtime services handed to devices ───────────────────────────────────────

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
}

export interface TimerOptions {
  readonly cite: readonly CitationId[];
  readonly confidence: Confidence;
}

export interface TimerHandle {
  readonly id: string;
  readonly name: string;
  readonly dueAt: SimTime;
}

export interface TimerApi {
  /** Fire `onFire` during the tick phase at `now + seconds`. `seconds` must be ≥ 1. */
  set(name: string, seconds: number, opts: TimerOptions, onFire: () => void): TimerHandle;
  cancel(handle: TimerHandle): void;
  pending(): readonly TimerHandle[];
}

export interface TickContext<TProfile = unknown> {
  readonly now: SimTime;
  readonly rng: Rng;
  readonly profile: TProfile;
  /** Read-only view of the world as of the end of the previous tick. */
  readonly prev: Snapshot;
  readonly timers: TimerApi;
  /** Queue a message; returns its id. Delivered in the next delivery round. */
  send<P>(msg: MessageDraft<P>): string;
  /** Record an event; returns its id (usable as a `causeId`). */
  emit(event: EventDraft): string;
}

/**
 * A simulated device. Hooks run root-first in sorted-id order each tick (SPEC §5.2):
 * actions → preTick → emit → deliver rounds (onMessage) → tick → postTick → snapshot.
 */
export interface Device<TProfile = unknown> {
  readonly id: DeviceId;
  readonly kind: string;
  readonly label: string;
  readonly parentId?: DeviceId;
  preTick?(ctx: TickContext<TProfile>): void;
  emit?(ctx: TickContext<TProfile>): void;
  onMessage?(msg: Message, ctx: TickContext<TProfile>): void;
  tick?(ctx: TickContext<TProfile>): void;
  postTick?(ctx: TickContext<TProfile>): void;
  view(): DeviceView;
}

// ── Actions (SPEC §5.5) ──────────────────────────────────────────────────────

export type ActionParams = Readonly<Record<string, string | number | boolean>>;

export interface ActionRequest {
  readonly kind: ActionKind;
  /** Device or link id. */
  readonly target: DeviceId | LinkId;
  readonly params?: ActionParams;
}

export interface ActionSpec {
  readonly kind: ActionKind;
  readonly label: string;
  readonly description?: string;
  /** Only applicable actions are offered in the UI. */
  appliesTo(target: DeviceView | LinkView): boolean;
  /** Parameter choices for the UI (e.g. bond modes). */
  readonly params?: Readonly<
    Record<string, { readonly label: string; readonly choices: readonly (string | number)[] }>
  >;
}

// ── The simulation facade the UI and tests use ───────────────────────────────

export interface Simulation {
  getSnapshot(): Snapshot;
  /** `useSyncExternalStore`-compatible subscription; listener fires after every tick/action. */
  subscribe(listener: () => void): () => void;
  /** Queue an action; it applies at the start of the next tick (SPEC §5.2 phase 1). */
  applyAction(action: ActionRequest): void;
  /** Advance `n` ticks (default 1) and return the resulting snapshot. */
  tick(n?: number): Snapshot;
  /** Advance until the soonest pending timer has fired (bounded by `maxTicks`). */
  runUntilNextTimer(maxTicks?: number): Snapshot;
  availableActions(target: DeviceId | LinkId): readonly ActionSpec[];
  eventLog(): readonly SimEvent[];
}
