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
 * SPDK initiator, so the backend's `health() === 'unavailable'` (every path declared lost by
 * keep-alive) is the proxy for "the service volumes are unreachable". Maintenance therefore
 * follows path-loss detection by the next monitor check and the 5 s threshold. Maintenance takes
 * the node out of the cluster, which is admitted only within the cluster's node-failure tolerance
 * (N−2 / N−3, `assumption`); a refused node keeps retrying at every check. In maintenance the
 * CVM's services (Stargate, ZK member, Cassandra, Acropolis) stop, which the rest of the model
 * treats exactly like a CVM that is down: the redirector moves the host's VM IO to a Stargate
 * that still reaches the array within seconds, and seats and leaders move. The backend keeps
 * reconnecting meanwhile. The first monitor check that finds the mounts healthy again takes the
 * node out of maintenance and the services restart (`hades.servicesRestartS`). The 300 s re-map
 * only reconnects volumes that are not connected; controllers that reconnected on their own do
 * not wait for it (the model keeps every controller inside its 3600 s loss window, so it never
 * gates recovery here). The topology option `hades-maintenance-on-storage-error` (default: the
 * profile) turns the rule off.
 */

import type { Ctx, StorageBackend } from '../contracts';

export type HadesState = 'ok' | 'maintenance' | 'restarting';

export type HadesStep =
  /** The error has lasted the threshold: put the node in maintenance mode now. */
  | 'enter-maintenance'
  /** A monitor check found the volumes healthy again: leave maintenance, restart services. */
  | 'volumes-healthy'
  | null;

export class Hades {
  state: HadesState = 'ok';
  /** First monitor check that saw the current error. */
  private errorSince: number | null = null;
  /** `hades.maintenance.refused` reported for the current episode. */
  refusedAnnounced = false;
  private lastCheckAt = Number.NEGATIVE_INFINITY;
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
      if (!monitored || this.backend.health() !== 'unavailable') this.refusedAnnounced = false;
      if (!monitored) {
        this.errorSince = null;
        return null;
      }
      if (!this.checkDue(ctx)) return null;
      if (this.backend.health() !== 'unavailable') {
        this.errorSince = null;
        return null;
      }
      this.errorSince ??= now;
      return now - this.errorSince >= H.externalStorageErrorThresholdS.value
        ? 'enter-maintenance'
        : null;
    }
    if (this.state !== 'maintenance' || !this.checkDue(ctx)) return null;
    return this.backend.health() !== 'unavailable' ? 'volumes-healthy' : null;
  }

  /** The volume monitor runs every `volumeMonitorIntervalS`. */
  private checkDue(ctx: Ctx): boolean {
    if (ctx.now - this.lastCheckAt < ctx.profile.hades.volumeMonitorIntervalS.value) return false;
    this.lastCheckAt = ctx.now;
    return true;
  }

  /** When the monitor will next decide something (for "fast-forward to next timer"). */
  nextDueAt(ctx: Ctx): number | null {
    if (!this.enabled) return null;
    const H = ctx.profile.hades;
    const nextCheck = this.lastCheckAt + H.volumeMonitorIntervalS.value;
    if (this.state === 'ok' && this.errorSince !== null) {
      return Math.max(this.errorSince + H.externalStorageErrorThresholdS.value, nextCheck);
    }
    // Only while the check's answer would change something: a lost backend (ok) or a healthy
    // one (maintenance). Otherwise the backend's own reconnect timers wake the engine.
    const unavailable = this.backend.health() === 'unavailable';
    if (this.state === 'ok' && unavailable) return nextCheck;
    if (this.state === 'maintenance' && !unavailable) return nextCheck;
    return null;
  }

  enterMaintenance(now: number): void {
    this.state = 'maintenance';
    this.enteredAt = now;
    this.errorSince = null;
  }

  beginRestart(): void {
    this.state = 'restarting';
  }

  /** Services are back (restart done) or the CVM was power-cycled: start monitoring afresh. */
  reset(): void {
    this.state = 'ok';
    this.errorSince = null;
    this.refusedAnnounced = false;
    this.lastCheckAt = Number.NEGATIVE_INFINITY;
    this.enteredAt = null;
  }
}
