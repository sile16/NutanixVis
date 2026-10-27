/**
 * A CVM node's physical disk (Bible 4i "Disk Failure"):
 * - A fault (`disk.fail`, or the generic `fail`) makes Stargate mark the disk offline. Its
 *   replicas are unavailable and Curator rebuild starts; there is no HA event.
 * - When the fault clears (`recover` / `disk.recover`), Hades runs a SMART check and returns the
 *   disk to service if it passes, unless the disk went offline
 *   `hci.diskOfflineEventsPerHourToStayOffline` times within an hour: then it stays offline.
 * - `disk.recover` on a disk kept offline models an operator re-adding it (its data is wiped).
 *
 * Also drives the shared store's per-tick Curator work, so the rebuild does not depend on any
 * one CVM's hook delegation.
 */
import type { EngineDevice } from '../../../engine/context';
import { asEngineContext } from '../../../engine/context';
import type {
  DeviceId,
  DeviceStatus,
  DeviceView,
  EventDraft,
  TickContext,
  TimerHandle,
  ViewField,
} from '../../../engine/types';
import type { DeviceSpec } from '../../../topologies/schema';
import type { Profile } from '../../versions/profile';
import { HCI_ASSUMPTIONS } from './assumptions';
import type { DiskHandle, HciStore } from './store';

type DiskSpec = Extract<DeviceSpec, { kind: 'disk' }>;
export type DiskState = 'online' | 'offline' | 'smart-check' | 'failed';
type Ctx = TickContext<Profile>;

const STATUS: Readonly<Record<DiskState, DeviceStatus>> = {
  online: 'healthy',
  'smart-check': 'degraded',
  offline: 'offline',
  failed: 'failed',
};

export class DiskDevice implements EngineDevice<Profile>, DiskHandle {
  readonly kind = 'disk';
  readonly id: DeviceId;
  readonly label: string;
  readonly parentId?: DeviceId;
  readonly capacityTiB: number;
  private state: DiskState = 'online';
  /** The disk itself is faulted (engine-failed). */
  private faulted = false;
  /** Its host (an ancestor) is down. */
  private hostDown = false;
  private offlineAt: number[] = [];
  private offlineEvent: string | undefined;
  private smart: TimerHandle | undefined;
  private now = 0;

  constructor(
    private readonly spec: DiskSpec,
    readonly node: DeviceId,
    private readonly store: HciStore,
    private readonly anchor: boolean,
  ) {
    this.id = spec.id;
    this.label = spec.label;
    if (spec.parent !== undefined) this.parentId = spec.parent;
    this.capacityTiB = spec.capacityTiB;
    store.registerDisk(this);
  }

  // ── DiskHandle ────────────────────────────────────────────────────────────

  serving(): boolean {
    return !this.faulted && !this.hostDown && this.state === 'online';
  }

  lastOfflineEvent(): string | undefined {
    return this.offlineEvent;
  }

  get diskState(): DiskState {
    return this.state;
  }

  get isFaulted(): boolean {
    return this.faulted;
  }

  // ── Hooks ─────────────────────────────────────────────────────────────────

  tick(ctx: Ctx): void {
    this.now = ctx.now;
    this.store.advance(ctx);
  }

  onFail(ctx: Ctx): void {
    this.now = ctx.now;
    const e = asEngineContext(ctx);
    if (this.parentId !== undefined && !e.isUp(this.parentId)) {
      this.hostDown = true;
      return;
    }
    this.faulted = true;
    this.offlineAt.push(ctx.now);
    if (this.smart) ctx.timers.cancel(this.smart);
    this.smart = undefined;
    if (this.state !== 'failed') this.state = 'offline';
    this.offlineEvent = ctx.emit({
      severity: 'warn',
      deviceId: this.id,
      code: 'disk.offline',
      text: `Stargate marked ${this.label} on ${this.parentId ?? this.node} offline; its replicas are unavailable (no HA event)`,
      causeIds: [],
      cite: ['ntnx-bible-4i'],
      confidence: 'verified',
    });
  }

  onRecover(ctx: Ctx): void {
    this.now = ctx.now;
    if (!this.faulted) {
      this.hostDown = false;
      return;
    }
    this.faulted = false;
    const limit = ctx.profile.hci.diskOfflineEventsPerHourToStayOffline;
    const cause = this.offlineEvent === undefined ? [] : [this.offlineEvent];
    if (this.state === 'failed' || this.recentOfflineEvents() >= limit.value) {
      if (this.state !== 'failed') {
        this.state = 'failed';
        ctx.emit({
          severity: 'error',
          deviceId: this.id,
          code: 'disk.kept-offline',
          text: `${this.label} went offline ${this.recentOfflineEvents()} times within an hour: Hades keeps it out of service`,
          causeIds: cause,
          cite: limit.cite,
          confidence: limit.confidence,
        });
      }
      return;
    }
    this.state = 'smart-check';
    const smartCheckS = HCI_ASSUMPTIONS.diskSmartCheckS;
    const started = ctx.emit({
      severity: 'info',
      deviceId: this.id,
      code: 'disk.smart-check',
      text: `Hades runs a SMART check on ${this.label}`,
      causeIds: cause,
      cite: ['ntnx-bible-4i'],
      confidence: 'verified',
    });
    this.smart = ctx.timers.set(
      'disk.smart-check',
      Math.max(1, smartCheckS.value),
      { cite: smartCheckS.cite, confidence: smartCheckS.confidence },
      () => {
        this.smart = undefined;
        this.state = 'online';
        ctx.emit({
          severity: 'info',
          deviceId: this.id,
          code: 'disk.online',
          text: `${this.label} passed its SMART check and is back in service`,
          causeIds: [started],
          cite: ['ntnx-bible-4i'],
          confidence: 'verified',
        });
      },
    );
  }

  /** Operator re-adds a disk Hades kept offline: its old data is gone, history resets. */
  reAdd(emit: (e: EventDraft) => string, causeIds: readonly string[]): void {
    if (this.state !== 'failed' || this.faulted) return;
    this.state = 'online';
    this.offlineAt = [];
    this.store.forgetDisk(this.id);
    emit({
      severity: 'info',
      deviceId: this.id,
      code: 'disk.online',
      text: `${this.label} re-added by an operator (its old data is discarded)`,
      causeIds,
      cite: ['ntnx-bible-4i'],
      confidence: 'inferred',
    });
  }

  private recentOfflineEvents(): number {
    const window = HCI_ASSUMPTIONS.diskOfflineWindowS.value;
    const now = Math.max(this.now, this.store.now());
    return this.offlineAt.filter((t) => now - t < window).length;
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  view(): DeviceView {
    const fields: Record<string, ViewField> = {
      state: this.state,
      offlineEventsLastHour: this.recentOfflineEvents(),
      media: this.spec.media,
      capacityTiB: this.spec.capacityTiB,
      cvm: this.node,
      replicas: this.store.replicasOnDisk(this.id),
    };
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      ...(this.parentId === undefined ? {} : { parent: this.parentId }),
      status: STATUS[this.state],
      badges: [],
      fields,
    };
  }

  derived(): Readonly<Record<string, ViewField>> {
    return this.anchor ? this.store.derived() : {};
  }
}
