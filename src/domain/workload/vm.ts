/**
 * VM / vDisk workload (SPEC §6.1). A VM is a steady IO generator plus a lifecycle:
 * `running | io-stalled | paused | crashed | restarting | off` (docs/view-fields.md `vm`).
 *
 * The VM knows nothing about Nutanix internals: it reaches storage through a `VmEnv` the Nutanix
 * domain provides (the host's iSCSI redirector, fencing, isolation and path-loss facts). AHV HA
 * drives `crash` / `beginRestart` / `startOn`. VMs keep their id after a restart; `host` says
 * where the process runs now and `instances` lists every host with a live process (invariant:
 * never more than one).
 */

import { asEngineContext } from '../../engine/context';
import type { Device, DeviceStatus, DeviceView, ViewField } from '../../engine/types';
import type { Ctx, IoRequest } from '../contracts';
import type { Profile } from '../versions/profile';
import { WORKLOAD, type WorkloadModel } from './io';

export type VmLifecycle = 'running' | 'paused' | 'crashed' | 'restarting' | 'off';
export type VmState = VmLifecycle | 'io-stalled';
/** Why a stopped VM should come back: after an HA fence, or at the next HA cycle. */
export type RestartNeed = 'none' | 'ha' | 'next-cycle';

export type IoTarget =
  /** `session` changes on every (re-)login; outstanding IO is re-issued on a new session. */
  | { readonly status: 'ready'; readonly cvm: string; readonly session: number }
  /** The session is re-logging in to another Stargate (redirect stall): IO waits. */
  | { readonly status: 'held' }
  /** No reachable healthy Stargate: the IO cannot be issued (counts as a failed IO). */
  | { readonly status: 'no-path' };

export interface StorageUse {
  readonly paths: readonly string[];
  readonly uplinks: readonly string[];
}

/** What the VM needs from the platform (implemented by the Nutanix domain). */
export interface VmEnv {
  hostAlive(host: string): boolean;
  /** AHV HA fenced the host: Stargates refuse its IO. */
  hostFenced(host: string): boolean;
  /** The host is cut off from the cluster's quorum side (which exists): isolation. */
  hostCutOff(host: string): boolean;
  target(host: string, vdisk: string): IoTarget;
  /** Send `io` over the host's current session; returns the message id. */
  send(host: string, vm: string, io: IoRequest, ctx: Ctx): string | null;
  ownerCvm(vdisk: string): string | null;
  /** NVMe-leg usage of the vDisk's serving CVM (backend `pathsFor`). */
  storageUse(vdisk: string): StorageUse;
  /** The serving CVM has lost all array paths (T1); always false where not applicable. */
  storageLost(vdisk: string): boolean;
  hostOfNic(nic: string): string | undefined;
}

export interface VmSpec {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly vdisks: readonly string[];
  readonly pathLossForceShutdownS: number | null;
}

interface Pending {
  readonly req: IoRequest;
  msgId: string | null;
  sentTo: string | null;
  session: number | null;
  needsSend: boolean;
}

const STATUS: Readonly<Record<VmState, DeviceStatus>> = {
  running: 'healthy',
  'io-stalled': 'stalled',
  paused: 'stalled',
  crashed: 'failed',
  restarting: 'degraded',
  off: 'offline',
};

export class Vm implements Device<Profile> {
  readonly kind = 'vm';
  readonly id: string;
  readonly label: string;
  /** Topology parent; kept for stable rendering (tests read `host`). */
  private readonly specHost: string;
  readonly vdisks: readonly string[];
  private lifecycle: VmLifecycle = 'running';
  private hostId: string | null;
  /** Last host it ran on (HA restarts the VMs of a lost host). */
  private home: string;
  private need: RestartNeed = 'none';
  private needSince = 0;
  private forceShutdownS: number | null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private sentThisTick: { msgId: string; ioId: string }[] = [];
  private okThisTick = 0;
  private failedThisTick = false;
  private firstFailedIoAt: number | null = null;
  private stuckSince: number | null = null;
  private guestTimeoutRaised = false;
  private ioErrorRaised = false;
  private uplinks = new Set<string>();
  private shownUplinks: readonly string[] = [];
  private shownPaths: readonly string[] = [];
  private state: VmState = 'running';
  private pendingS = { all: 0, read: 0, write: 0 };
  private latencyMs = 0;

  constructor(
    spec: VmSpec,
    private readonly env: VmEnv,
    private readonly model: WorkloadModel = WORKLOAD,
  ) {
    this.id = spec.id;
    this.label = spec.label;
    this.specHost = spec.host;
    this.hostId = spec.host;
    this.home = spec.host;
    this.vdisks = spec.vdisks;
    this.forceShutdownS = spec.pathLossForceShutdownS;
  }

  // ── Queries used by AHV HA ──────────────────────────────────────────────

  get host(): string | null {
    return this.hostId;
  }
  get homeHost(): string {
    return this.home;
  }
  get restartNeed(): RestartNeed {
    return this.need;
  }
  /** When the current restart need arose (for "next HA cycle" restarts). */
  get restartNeedSince(): number {
    return this.needSince;
  }
  get currentState(): VmState {
    return this.state;
  }
  hasLiveInstance(): boolean {
    return this.hostId !== null;
  }
  get pathLossForceShutdownS(): number | null {
    return this.forceShutdownS;
  }
  setPathLossForceShutdownS(s: number | null): void {
    this.forceShutdownS = s;
    this.stuckSince = null;
  }

  // ── Lifecycle transitions ───────────────────────────────────────────────

  /** The process died with its host (power loss, host reboot). HA restarts it after the fence. */
  crash(ctx: Ctx, causeIds: readonly string[], why: string): void {
    if (this.hostId === null) return;
    this.kill('crashed', 'ha', ctx.now);
    ctx.emit({
      severity: 'error',
      deviceId: this.id,
      code: 'vm.crashed',
      text: `${this.label} crashed: ${why}`,
      causeIds,
      cite: [],
    });
  }

  /** HA is restarting it (fence reached, or next cycle after a force-shutdown). */
  beginRestart(): void {
    if (this.hostId !== null || this.need === 'none') return;
    this.lifecycle = 'restarting';
    this.state = 'restarting';
  }

  /** Start a fresh process on `host` (HA restart or power-on). */
  startOn(host: string, ctx: Ctx, causeIds: readonly string[], viaHa: boolean): string | null {
    if (this.hostId !== null) return null;
    this.lifecycle = 'running';
    this.state = 'running';
    this.hostId = host;
    this.home = host;
    this.need = 'none';
    this.resetIo();
    if (!viaHa) return null;
    return ctx.emit({
      severity: 'info',
      deviceId: this.id,
      code: 'ha.vm.restarted',
      text: `${this.label} restarted by AHV HA on ${host}`,
      causeIds,
      cite: ctx.profile.ahvHa.restartByS.cite,
      confidence: ctx.profile.ahvHa.restartByS.confidence,
    });
  }

  powerOff(): void {
    if (this.lifecycle === 'off') return;
    this.kill('off', 'none', 0);
  }

  pause(on: boolean): void {
    if (this.hostId === null) return;
    this.lifecycle = on ? 'paused' : 'running';
  }

  // ── Device hooks (called by the owning device wrapper) ──────────────────

  preTick(ctx: Ctx): void {
    this.sentThisTick = [];
    this.okThisTick = 0;
    this.failedThisTick = false;
    this.uplinks = new Set();
    if (this.hostId !== null && !this.env.hostAlive(this.hostId)) {
      this.crash(ctx, [], `host ${this.hostId} is down`);
    }
  }

  emit(ctx: Ctx): void {
    const host = this.hostId;
    if (host === null || this.lifecycle !== 'running') return;
    for (const vdisk of this.vdisks) this.issue(vdisk, ctx);
    let noPath = false;
    for (const [ioId, p] of this.pending) {
      const t = this.env.target(host, p.req.vdisk);
      if (t.status === 'held') continue;
      if (t.status === 'no-path') {
        noPath = true;
        continue;
      }
      if (!p.needsSend && p.sentTo === t.cvm && p.session === t.session) continue;
      // Mark sent first: a reply may arrive before `send` returns.
      p.sentTo = t.cvm;
      p.session = t.session;
      p.needsSend = false;
      const msgId = this.env.send(host, this.id, p.req, ctx);
      if (msgId === null) {
        p.needsSend = true;
        noPath = true;
        continue;
      }
      p.msgId = msgId;
      this.sentThisTick.push({ msgId, ioId });
    }
    if (noPath) this.markFailed(ctx.now);
  }

  /** IO reply delivered to the host's redirector endpoint. */
  onReply(
    ioId: string,
    reply: { status: 'ok'; latencyMs: number } | { status: 'error' | 'retry'; reason: string },
    msgId: string,
    ctx: Ctx,
  ): void {
    const p = this.pending.get(ioId);
    if (!p || this.hostId === null) return;
    this.collectUplinks(msgId, ctx);
    if (reply.status === 'ok') {
      this.pending.delete(ioId);
      this.okThisTick++;
      this.latencyMs = reply.latencyMs;
      return;
    }
    this.markFailed(ctx.now);
    if (reply.status === 'retry') {
      p.needsSend = true;
      return;
    }
    // Terminal error (e.g. every path's controller deleted): the guest sees an IO error.
    this.pending.delete(ioId);
    if (!this.ioErrorRaised) {
      this.ioErrorRaised = true;
      ctx.emit({
        severity: 'error',
        deviceId: this.id,
        code: 'vm.io.error',
        text: `${this.label}: IO failed back to the guest (${reply.reason})`,
        causeIds: [],
        cite: [],
      });
    }
  }

  tick(ctx: Ctx): void {
    const host = this.hostId;
    if (host === null) return;
    const ectx = asEngineContext(ctx);
    for (const s of this.sentThisTick) {
      const tr = ectx.trace(s.msgId);
      const p = this.pending.get(s.ioId);
      if (!tr || !p) continue;
      if (tr.result === 'dropped') {
        // TCP retransmits the request; the drop is a failed IO for HA purposes.
        p.needsSend = true;
        this.markFailed(ctx.now);
      } else {
        this.addUplinks(tr.links, ctx);
      }
    }
    const P = ctx.profile;
    // Bible 5b: VMs on a partitioned host fail 45 s after their first IO failure. Only while a
    // quorum side exists that will restart them (SPEC §14 #1: no majority anywhere → VMs stall).
    if (
      this.firstFailedIoAt !== null &&
      ctx.now - this.firstFailedIoAt >= P.ahvHa.isolatedVmSelfTerminateS.value &&
      this.env.hostCutOff(host)
    ) {
      this.selfTerminate(ctx);
      return;
    }
    this.checkForceShutdown(ctx);
  }

  postTick(ctx: Ctx): void {
    if (this.okThisTick > 0 && !this.failedThisTick) {
      this.firstFailedIoAt = null;
      this.ioErrorRaised = false;
    }
    const now = ctx.now;
    let all = 0;
    let read = 0;
    let write = 0;
    for (const p of this.pending.values()) {
      const age = now - p.req.issuedAt;
      all = Math.max(all, age);
      if (p.req.op === 'read') read = Math.max(read, age);
      else write = Math.max(write, age);
    }
    this.pendingS = { all, read, write };
    const paths = new Set<string>();
    if (this.hostId !== null && this.lifecycle === 'running') {
      for (const v of this.vdisks) {
        const use = this.env.storageUse(v);
        for (const p of use.paths) paths.add(p);
        for (const u of use.uplinks) this.uplinks.add(u);
      }
      this.shownUplinks = [...this.uplinks].sort();
    }
    this.shownPaths = [...paths].sort();
    this.state = this.computeState();

    const timeout = ctx.profile.guest.linuxScsiTimeoutS;
    if (all > timeout.value && !this.guestTimeoutRaised) {
      this.guestTimeoutRaised = true;
      ctx.emit({
        severity: 'warn',
        deviceId: this.id,
        code: 'vm.io.guest-timeout',
        text: `${this.label}: an IO has been pending ${all} s, past the ${timeout.value} s guest disk timeout`,
        causeIds: [],
        cite: timeout.cite,
        confidence: timeout.confidence,
      });
    } else if (all <= timeout.value) {
      this.guestTimeoutRaised = false;
    }
  }

  view(): DeviceView {
    const fields: Record<string, ViewField> = {
      state: this.state,
      host: this.hostId,
      instances: JSON.stringify(this.hostId === null ? [] : [this.hostId]),
      ioPendingS: this.pendingS.all,
      readPendingS: this.pendingS.read,
      writePendingS: this.pendingS.write,
      ownerCvm: this.vdisks[0] === undefined ? null : this.env.ownerCvm(this.vdisks[0]),
      ioPaths: JSON.stringify(this.shownPaths),
      ioUplinks: JSON.stringify(this.shownUplinks),
      pathLossForceShutdownS: this.forceShutdownS,
      vdisks: JSON.stringify(this.vdisks),
      outstandingIo: this.pending.size,
      ioLatencyMs: this.latencyMs,
      restartNeed: this.need,
    };
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      parent: this.specHost,
      status: STATUS[this.state],
      badges: [],
      fields,
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private computeState(): VmState {
    if (this.lifecycle !== 'running') return this.lifecycle;
    if (this.hostId !== null && this.env.hostFenced(this.hostId)) return 'io-stalled';
    if (this.okThisTick > 0) return 'running';
    // Stalled = outstanding IO that has had a tick to complete and has not. IO issued this tick
    // and still in flight (pipeline fill right after a start or re-login) is not a stall.
    return this.pendingS.all > 0 ? 'io-stalled' : 'running';
  }

  private issue(vdisk: string, ctx: Ctx): void {
    let n = 0;
    for (const p of this.pending.values()) if (p.req.vdisk === vdisk) n++;
    const qd = this.model.queueDepth.value;
    const ops: ('read' | 'write')[] = [
      ...Array<'read'>(this.model.readsPerTick.value).fill('read'),
      ...Array<'write'>(this.model.writesPerTick.value).fill('write'),
    ];
    for (const op of ops) {
      if (n >= qd) return;
      const seq = ++this.seq;
      const req: IoRequest = {
        id: `${this.id}#${seq}`,
        vdisk,
        vm: this.id,
        op,
        // Alternate small / large so MTU problems show up as "small IO works, large stalls".
        size: Math.floor(seq / 2) % 2 === 0 ? 'small' : 'large',
        issuedAt: ctx.now,
      };
      this.pending.set(req.id, { req, msgId: null, sentTo: null, session: null, needsSend: true });
      n++;
    }
  }

  private markFailed(now: number): void {
    this.failedThisTick = true;
    this.firstFailedIoAt ??= now;
  }

  private collectUplinks(msgId: string, ctx: Ctx): void {
    const tr = asEngineContext(ctx).trace(msgId);
    if (tr) this.addUplinks(tr.links, ctx);
  }

  /** iSCSI leg: NICs of the VM's own host that the frame crossed. */
  private addUplinks(links: readonly string[], ctx: Ctx): void {
    const net = asEngineContext(ctx).net;
    for (const id of links) {
      const l = net.link(id);
      if (!l) continue;
      for (const end of [l.a, l.b]) {
        if (this.env.hostOfNic(end) === this.hostId) this.uplinks.add(end);
      }
    }
  }

  private selfTerminate(ctx: Ctx): void {
    const P = ctx.profile.ahvHa.isolatedVmSelfTerminateS;
    const since = this.firstFailedIoAt ?? ctx.now;
    this.kill('crashed', 'ha', ctx.now);
    ctx.emit({
      severity: 'error',
      deviceId: this.id,
      code: 'ha.vm.self-terminated',
      text: `${this.label} self-terminated: isolated host, IO failing since T=${since} (${P.value} s)`,
      causeIds: [],
      cite: P.cite,
      confidence: P.confidence,
    });
  }

  /**
   * T1 per-VM path-loss handling (DEPLOY-GUIDE "Compute Cluster High Availability"; SPEC §14 #7):
   * the timeout counts from the first IO that could not complete because the serving CVM lost
   * every array path; on expiry the VM is powered off and AHV HA restarts it at the next cycle.
   */
  private checkForceShutdown(ctx: Ctx): void {
    const limit = this.forceShutdownS;
    if (limit === null || this.lifecycle !== 'running') return;
    const lost = this.vdisks.some((v) => this.env.storageLost(v));
    if (!lost || this.pending.size === 0) {
      this.stuckSince = null;
      return;
    }
    let oldest = ctx.now;
    for (const p of this.pending.values()) oldest = Math.min(oldest, p.req.issuedAt);
    this.stuckSince ??= oldest;
    if (ctx.now - this.stuckSince < limit) return;
    this.kill('off', 'next-cycle', ctx.now);
    const P = ctx.profile.externalStorage.pathLossDefault;
    ctx.emit({
      severity: 'warn',
      deviceId: this.id,
      code: 'vm.force-shutdown',
      text: `${this.label} force-shut down: storage path lost for ${limit} s (per-VM timeout)`,
      causeIds: [],
      cite: P.cite,
      confidence: 'assumption',
    });
  }

  private kill(to: VmLifecycle, need: RestartNeed, now: number): void {
    if (this.hostId !== null) this.home = this.hostId;
    this.hostId = null;
    this.lifecycle = to;
    this.state = to;
    this.need = need;
    this.needSince = now;
    this.resetIo();
  }

  private resetIo(): void {
    this.pending.clear();
    this.sentThisTick = [];
    this.firstFailedIoAt = null;
    this.stuckSince = null;
    this.guestTimeoutRaised = false;
    this.ioErrorRaised = false;
    this.pendingS = { all: 0, read: 0, write: 0 };
    this.uplinks = new Set();
    this.shownUplinks = [];
    this.shownPaths = [];
  }
}
