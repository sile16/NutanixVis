/**
 * Hades external-storage monitor (T1 / T1-lab; SPEC §6.4a "One CVM loses all array paths").
 *
 * On external storage the Zookeeper, Cassandra and Curator data live on per-CVM "service
 * volumes" on the array (Bible 8c), which the CVM reaches through its kernel NVMe/TCP initiator
 * and Linux native multipathing ("Nutanix will be leveraging Linux native multipathing",
 * Everpure "Nutanix Cloud Infrastructure Configuration"), managed by Hades. AOS 7.6 Hades gflags
 * (Command Reference 7.6):
 *
 * - the volume mounts are checked every `hades.volumeMonitorIntervalS` (5 s);
 * - an external-storage error lasting `hades.externalStorageErrorThresholdS` (5 s) is "critical"
 *   and puts the node in maintenance mode;
 * - every `hades.mapNvmfVolumesIntervalS` (300 s) Hades connects all NVMf volumes again.
 *
 * Model (`inferred`): the kernel path uses the same CVM storage vNICs and FA ports as Stargate's
 * SPDK initiator, so the backend's `health() === 'unavailable'` is the proxy for "the service
 * volumes are unreachable". The kernel initiator queues IO while it waits for a path (controller
 * loss 3600 s), so a mount check only fails once its IO is abandoned at the NVMe IO timeout
 * (`externalStorage.ioTimeoutS`): maintenance follows path-loss detection, that timeout and the
 * 5 s threshold. Maintenance takes the node out of the cluster, which is admitted only within the
 * cluster's node-failure tolerance (N−2 / N−3, `assumption`); a refused node keeps retrying at
 * every check. In maintenance the CVM's services (Stargate, ZK member, Cassandra,
 * Acropolis) stop, which the rest of the model treats exactly like a CVM that is down: the
 * redirector moves the host's VM IO to a Stargate that still reaches the array, and seats and
 * leaders move. The backend keeps reconnecting meanwhile; after a re-map that finds the array
 * the services restart (`cluster.cvmBootS` settling). The topology option
 * `hades-maintenance-on-storage-error` (default: the profile) turns the rule off for lab L1.
 */

import type { Ctx, StorageBackend } from '../contracts';

export type HadesState = 'ok' | 'maintenance' | 'restarting';

export type HadesStep =
  /** The error has lasted the threshold: put the node in maintenance mode now. */
  | 'enter-maintenance'
  /** A re-map found the volumes again: restart the CVM services now. */
  | 'remapped'
  | null;

export class Hades {
  state: HadesState = 'ok';
  /** First monitor check that saw the current error. */
  private errorSince: number | null = null;
  /** First tick the backend had no live path (the check IO starts waiting then). */
  private unavailableSince: number | null = null;
  /** `hades.maintenance.refused` reported for the current episode. */
  refusedAnnounced = false;
  private lastCheckAt = Number.NEGATIVE_INFINITY;
  /** Next periodic re-map while in maintenance. */
  nextRemapAt: number | null = null;
  enteredAt: number | null = null;

  constructor(
    private readonly backend: StorageBackend,
    private readonly enabled: boolean,
  ) {}

  /**
   * Called each tick while the CVM is powered on. `monitored` is false when the backend is not
   * running (Stargate stopped by an operator), so its health is no proxy for the volumes.
   */
  step(ctx: Ctx, monitored: boolean): HadesStep {
    if (!this.enabled) return null;
    const H = ctx.profile.hades;
    const now = ctx.now;
    if (this.state === 'ok') {
      if (!monitored || this.backend.health() !== 'unavailable') {
        this.unavailableSince = null;
        this.refusedAnnounced = false;
      } else this.unavailableSince ??= now;
      if (!monitored) {
        this.errorSince = null;
        return null;
      }
      if (now - this.lastCheckAt < H.volumeMonitorIntervalS.value) return null;
      this.lastCheckAt = now;
      const since = this.unavailableSince;
      if (since === null || now - since < this.detectS(ctx)) {
        this.errorSince = null;
        return null;
      }
      this.errorSince ??= now;
      return now - this.errorSince >= H.externalStorageErrorThresholdS.value
        ? 'enter-maintenance'
        : null;
    }
    if (this.state !== 'maintenance' || this.nextRemapAt === null || now < this.nextRemapAt) {
      return null;
    }
    if (this.backend.health() !== 'unavailable') return 'remapped';
    this.nextRemapAt += H.mapNvmfVolumesIntervalS.value;
    return null;
  }

  /** A mount check fails once its IO is abandoned (the NVMe IO timeout). */
  private detectS(ctx: Ctx): number {
    return ctx.profile.externalStorage.ioTimeoutS.value;
  }

  /** When the monitor will next decide something (for "fast-forward to next timer"). */
  nextDueAt(ctx: Ctx): number | null {
    if (!this.enabled) return null;
    if (this.state === 'maintenance') return this.nextRemapAt;
    if (this.state === 'ok' && this.errorSince !== null) {
      return this.errorSince + ctx.profile.hades.externalStorageErrorThresholdS.value;
    }
    if (this.state === 'ok' && this.unavailableSince !== null) {
      return this.unavailableSince + this.detectS(ctx);
    }
    return null;
  }

  enterMaintenance(now: number, ctx: Ctx): void {
    this.state = 'maintenance';
    this.enteredAt = now;
    this.errorSince = null;
    this.nextRemapAt = now + ctx.profile.hades.mapNvmfVolumesIntervalS.value;
  }

  beginRestart(): void {
    this.state = 'restarting';
    this.nextRemapAt = null;
  }

  /** Services are back (restart done) or the CVM was power-cycled: start monitoring afresh. */
  reset(): void {
    this.state = 'ok';
    this.errorSince = null;
    this.unavailableSince = null;
    this.refusedAnnounced = false;
    this.lastCheckAt = Number.NEGATIVE_INFINITY;
    this.nextRemapAt = null;
    this.enteredAt = null;
  }
}
