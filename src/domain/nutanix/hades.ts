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
 * keep-alive) is the proxy for "every path to the service volumes is gone".
 * - Once that has lasted `hades.mountFailAfterS` (the multipath fast-IO-fail time, `assumption`),
 *   multipath fails the service-volume IO instead of queueing it: the mounts go bad and **stay
 *   bad** even if the array returns, until Hades remounts them. A shorter loss is a plain stall.
 * - Hades acts on the bad mounts at its next monitor check plus the 5 s threshold, so a
 *   whole-array blip just past the fast-IO-fail time still puts every node in maintenance.
 * - Each node decides on its own volumes: there is no cluster-wide admission limit. A
 *   single-fabric loss never triggers it (the other fabric keeps the mounts healthy).
 *
 * In maintenance the CVM's services (Stargate, ZK member, Cassandra, Acropolis) stop, which the rest of the model
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
  /** First tick every path was gone (null while some path is live). */
  private lostSince: number | null = null;
  /** The mounts failed (paths gone past `mountFailAfterS`); they stay bad until a remount. */
  private mountsBad = false;
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
      if (!monitored) {
        this.errorSince = null;
        this.lostSince = null;
        this.mountsBad = false;
        return null;
      }
      if (this.backend.health() === 'unavailable') {
        this.lostSince ??= now;
        if (now - this.lostSince >= H.mountFailAfterS.value) this.mountsBad = true;
      } else this.lostSince = null;
      if (!this.checkDue(ctx)) return null;
      if (!this.mountsBad) {
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
    if (this.state === 'ok' && this.mountsBad) return nextCheck;
    if (this.state === 'ok' && this.lostSince !== null) {
      return Math.max(this.lostSince + H.mountFailAfterS.value, nextCheck);
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

  /** The mounts were remounted (healthy at a check): leave maintenance, services restart. */
  beginRestart(): void {
    this.state = 'restarting';
    this.mountsBad = false;
    this.lostSince = null;
  }

  /** Services are back (restart done) or the CVM was power-cycled: start monitoring afresh. */
  reset(): void {
    this.state = 'ok';
    this.errorSince = null;
    this.lostSince = null;
    this.mountsBad = false;
    this.lastCheckAt = Number.NEGATIVE_INFINITY;
    this.enteredAt = null;
  }
}
