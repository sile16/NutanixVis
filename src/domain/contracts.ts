/**
 * Phase 2 domain contract (SPEC §13.2 streams E/F/G; integrator-owned). How the Nutanix services
 * (F), the external-storage NVMe/TCP path (E) and the HCI data path (G) plug together without
 * editing each other's code. Behavior values come only from `Profile`; never hard-code timers.
 *
 * Shape:
 *   F owns the CVM device. A CVM hosts `CvmComponent`s and delegates its hooks to them; its
 *   Stargate performs vDisk IO through one `StorageBackend` (E's NVMe initiator in T1/T1-lab,
 *   G's extent store in T2/T3). E and G receive a `ClusterView` from F at attach time.
 *   The integrator composes everything in `src/loader/domain.ts`.
 */
import type { ActionDefinition } from '../engine/actions';
import type {
  Device,
  DeviceId,
  EndpointId,
  Message,
  SimTime,
  TickContext,
  ViewField,
} from '../engine/types';
import type { Topology } from '../topologies/schema';
import type { Profile } from './versions/profile';

export type Ctx = TickContext<Profile>;

/**
 * A piece of behavior living inside a device (e.g. an NVMe initiator inside a CVM). The owning
 * device calls these in its own hooks, in component order.
 */
export interface CvmComponent {
  readonly name: string;
  preTick?(ctx: Ctx): void;
  emit?(ctx: Ctx): void;
  /** Return true if this component consumed the message (stops delegation). */
  onMessage?(msg: Message, ctx: Ctx): boolean;
  tick?(ctx: Ctx): void;
  postTick?(ctx: Ctx): void;
  onFail?(ctx: Ctx): void;
  onRecover?(ctx: Ctx): void;
  /** Merged into the owning CVM's `DeviceView.fields` (see docs/view-fields.md). */
  viewFields?(): Readonly<Record<string, ViewField>>;
  /** Merged into `Snapshot.derived`. */
  derived?(): Readonly<Record<string, ViewField>>;
}

export type IoOp = 'read' | 'write';

export interface IoRequest {
  /** Unique per IO; used as `causeId` on the messages it generates. */
  readonly id: string;
  readonly vdisk: string;
  /** VM that issued it (for path-usage views and traces). */
  readonly vm: DeviceId;
  readonly op: IoOp;
  readonly size: 'small' | 'large';
  readonly issuedAt: SimTime;
}

export type IoOutcome =
  | { readonly status: 'ok'; readonly latencyMs: number }
  /** Terminal failure (e.g. every path's controller deleted). The guest sees an IO error. */
  | { readonly status: 'error'; readonly reason: string };

export interface IoCompletion {
  readonly req: IoRequest;
  readonly outcome: IoOutcome;
  readonly completedAt: SimTime;
}

/** How a CVM's Stargate stores and fetches vDisk data. Also a component of that CVM. */
export interface StorageBackend extends CvmComponent {
  readonly kind: 'external-nvme' | 'hci';
  /** Called once after all devices exist. */
  attach(cluster: ClusterView): void;
  /** Take/hand over exclusive ownership of a vDisk (T1: NVMe Persistent Reservation). */
  acquire(vdisk: string, ctx: Ctx): void;
  release(vdisk: string, ctx: Ctx): void;
  /** Queue an IO. Completion arrives later via `drain`, possibly several ticks later. */
  submit(req: IoRequest, ctx: Ctx): void;
  /** Completions since the last call, oldest first. */
  drain(): readonly IoCompletion[];
  /** `unavailable` = no IO can make progress (Stargate should report unhealthy upstream). */
  health(): 'ok' | 'degraded' | 'unavailable';
  /**
   * Optional (T1): every path is down and the target ended each one (it closed or reset the
   * connection), rather than going silent. IO on such paths errors at once instead of queueing.
   */
  lostByTarget?(): boolean;
  /** Links/endpoints a vDisk's IO currently uses (path-usage view). */
  pathsFor?(vdisk: string): readonly string[];
  /** Physical NICs (bond members) that carried a vDisk's IO during the last tick (vm `ioUplinks`). */
  uplinksFor?(vdisk: string): readonly string[];
}

/** Read-only cluster facts F exposes to E and G. */
export interface ClusterView {
  /** CVM ids in deterministic (sorted) order. */
  cvmIds(): readonly DeviceId[];
  isCvmUp(cvm: DeviceId): boolean;
  /** Stargate serving and not fenced. */
  isStargateUp(cvm: DeviceId): boolean;
  /** Endpoint a CVM uses for inter-CVM traffic (replication, rebuild). */
  cvmDataEndpoint(cvm: DeviceId): EndpointId;
  /** Endpoints of a CVM on external-storage segments (T1). */
  cvmStorageEndpoints(cvm: DeviceId): readonly EndpointId[];
  zkQuorum(): boolean;
  /**
   * The CVM is on the Zookeeper quorum side. Optional: the HCI store uses `false` (while some
   * side has quorum) as "this Stargate's ZK session is expiring", i.e. a silent peer.
   */
  inQuorum?(cvm: DeviceId): boolean;
  metadataAvailable(): boolean;
  /** Host fenced by AHV HA: IO from it must not be served. */
  isHostFenced(host: DeviceId): boolean;
  /**
   * Additional simultaneous node failures the cluster services tolerate right now: the ZK seats
   * above majority on the quorum side (HCI), or the N−2 / N−3 rule minus nodes already lost (T1).
   * 0 when there is no quorum.
   */
  serviceFailureTolerance(): number;
  /** CVM whose Stargate currently owns a vDisk (where the redirector points), or null. */
  vdiskOwner(vdisk: string): DeviceId | null;
  /**
   * Optional: why a CVM's Stargate is not serving. `clean-stop` (CVM reboot, Stargate stop,
   * Hades maintenance: peers see the sessions close at once) or `silent` (died with its CVM or
   * host: peers notice only by timeout); null while it serves.
   */
  stargateDownCause?(cvm: DeviceId): 'clean-stop' | 'silent' | null;
}

/** What each domain stream exports for the loader to compose. */
export interface DomainInput {
  readonly topology: Topology;
  readonly profile: Profile;
}

export interface DomainPart {
  readonly devices: readonly Device<Profile>[];
  readonly actions?: readonly ActionDefinition[];
  /** Message kind → traffic category (packet colors). */
  readonly traffic?: Readonly<Record<string, string>>;
}

/** Stream E. */
export type ExternalStorageDomain = (input: DomainInput) => DomainPart & {
  /** NVMe/TCP initiator for one CVM (one controller per CVM-storage-endpoint × FA target). */
  backendFor(cvm: DeviceId): StorageBackend;
};

/** Stream G. */
export type HciDomain = (input: DomainInput) => DomainPart & {
  backendFor(cvm: DeviceId): StorageBackend;
};

/** Stream F. */
export type NutanixDomain = (
  input: DomainInput & { readonly backendFor: (cvm: DeviceId) => StorageBackend },
) => DomainPart & { readonly cluster: ClusterView };
