/**
 * Engine extensions to the `types.ts` contract. These are additive: every engine `TickContext`
 * is an `EngineTickContext`, and devices may implement the optional `DeviceLifecycle` hooks.
 * Domain code reaches the extras through `asEngineContext(ctx)`.
 */
import type { NetworkQuery } from './network/runtime';
import type { EndpointAttach } from './network/spec';
import type { Device, DeviceId, EndpointId, FlowId, TickContext, Trace, ViewField } from './types';

export type TickPhase =
  | 'init'
  | 'actions'
  | 'preTick'
  | 'emit'
  | 'deliver'
  | 'tick'
  | 'postTick'
  | 'snapshot';

/** A trace with the engine's extra detail (all plain data, kept in snapshots). */
export interface EngineTrace extends Trace {
  readonly src: EndpointId;
  readonly dst: EndpointId;
  /** Illustrative path latency (sum of link latencies). */
  readonly latencyMs: number;
  /** Finer drop cause, e.g. `hung`, `different-vlan`, `ingress-member-not-active`. */
  readonly detail?: string;
  /** Egress NIC selected at the source, if the frame left the host. */
  readonly egress?: string;
}

export type DerivedValue = ViewField | Readonly<Record<string, ViewField>>;

/** Optional hooks a device may add on top of `Device`. */
export interface DeviceLifecycle<TProfile = unknown> {
  /** Called when the device (or an ancestor) goes down. Its timers are cancelled right after. */
  onFail?(ctx: TickContext<TProfile>): void;
  /** Called when the device comes back up (its and all ancestors' failures cleared). */
  onRecover?(ctx: TickContext<TProfile>): void;
  /** Merged into `Snapshot.derived` (sorted by device id) after postTick. */
  derived?(): Readonly<Record<string, DerivedValue>>;
}

export type EngineDevice<TProfile = unknown> = Device<TProfile> & DeviceLifecycle<TProfile>;

/**
 * Endpoint changes a device may make itself (an array disabling a data IP, fencing a host,
 * a floating VIP moving to the new primary). Uplink failures never touch endpoints: the owner
 * only sees missing replies.
 */
export interface EndpointControl {
  setUp(id: EndpointId, up: boolean, causeIds?: readonly string[]): void;
  setFenced(id: EndpointId, fenced: boolean, causeIds?: readonly string[]): void;
  /** Re-home an endpoint onto another NIC/bond/bridge; returns the `net.endpoint.moved` id. */
  move(id: EndpointId, attach: EndpointAttach, causeIds?: readonly string[]): string;
}

export interface EngineTickContext<TProfile = unknown> extends TickContext<TProfile> {
  /** The device this context belongs to. */
  readonly self: DeviceId;
  readonly phase: TickPhase;
  /** True unless the device or one of its ancestors has been failed. */
  isUp(id: DeviceId): boolean;
  /** Read-only network state (endpoints, bonds, links). */
  readonly net: NetworkQuery;
  /** Endpoint up/fenced/re-home controls. */
  readonly endpoints: EndpointControl;
  /** Build a `FlowId` for a message between two endpoints. */
  flow(
    src: EndpointId,
    dst: EndpointId,
    l4?: { srcPort?: number; dstPort?: number; proto?: FlowId['proto'] },
  ): FlowId;
  /** The trace of a message delivered or dropped during the current tick. */
  trace(msgId: string): EngineTrace | undefined;
}

const ENGINE_CTX = Symbol.for('nutanixvis.engine.ctx');

export function markEngineContext<T extends object>(ctx: T): T {
  Object.defineProperty(ctx, ENGINE_CTX, { value: true });
  return ctx;
}

export function isEngineContext<T>(ctx: TickContext<T>): ctx is EngineTickContext<T> {
  return (ctx as unknown as Record<symbol, unknown>)[ENGINE_CTX] === true;
}

/** Narrow a `TickContext` to the engine's extended context; throws if it is not one. */
export function asEngineContext<T>(ctx: TickContext<T>): EngineTickContext<T> {
  if (!isEngineContext(ctx)) throw new TypeError('not an engine TickContext');
  return ctx;
}
