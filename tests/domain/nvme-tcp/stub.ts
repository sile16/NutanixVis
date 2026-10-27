/**
 * Test doubles for stream E: a stub CVM that hosts an external-storage backend and drives a
 * steady IO stream for its host's VMs (so these tests do not depend on stream F), plus loaders
 * for T1 / T1-lab and a fake NVMe/TCP target for initiator unit tests.
 */

import type {
  ClusterView,
  IoCompletion,
  IoRequest,
  StorageBackend,
} from '../../../src/domain/contracts';
import {
  buildExternalStorage,
  type ExternalStorageBackend,
  type ExternalStoragePart,
} from '../../../src/domain/flasharray';
import { NVME_MSG } from '../../../src/domain/nvme-tcp/protocol';
import type { Profile } from '../../../src/domain/versions/profile';
import { asEngineContext, type EngineDevice } from '../../../src/engine/context';
import type {
  DeviceView,
  Message,
  SimEvent,
  SimTime,
  TickContext,
} from '../../../src/engine/types';
import { loadSimulation } from '../../../src/loader/simulation';
import type { OptionValues, TopologyId } from '../../../src/topologies';

type Ctx = TickContext<Profile>;

export interface StubIo {
  /** New IOs per VM per tick (while below `depth`). Default 4. */
  readonly perTick?: number;
  /** Max outstanding IOs per VM (guest queue depth). Default 16. */
  readonly depth?: number;
  readonly size?: 'small' | 'large';
}

/** A CVM that only hosts the backend and issues IO for `vms` (vDisk `<vm>.vd-1`). */
export class StubCvm implements EngineDevice<Profile> {
  readonly kind = 'cvm';
  readonly label: string;
  readonly pending = new Map<string, IoRequest>();
  readonly done: IoCompletion[] = [];
  /** IO stops being issued while false (to inspect in-flight handling). */
  issuing = true;
  private seq = 0;
  private readonly perTick: number;
  private readonly depth: number;
  private readonly size: 'small' | 'large';

  constructor(
    readonly id: string,
    readonly parentId: string,
    readonly backend: StorageBackend,
    readonly vms: readonly string[],
    io: StubIo = {},
  ) {
    this.label = id;
    this.perTick = io.perTick ?? 4;
    this.depth = io.depth ?? 16;
    this.size = io.size ?? 'large';
  }

  static vdisk(vm: string): string {
    return `${vm}.vd-1`;
  }

  /** Issue one IO now (also usable from tests). */
  submit(
    vm: string,
    ctx: Ctx,
    op: 'read' | 'write' = this.seq % 2 === 0 ? 'read' : 'write',
  ): IoRequest {
    const req: IoRequest = {
      id: `${vm}.io-${++this.seq}`,
      vdisk: StubCvm.vdisk(vm),
      vm,
      op,
      size: this.size,
      issuedAt: ctx.now,
    };
    this.pending.set(req.id, req);
    this.backend.submit(req, ctx);
    return req;
  }

  preTick(ctx: Ctx): void {
    this.backend.preTick?.(ctx);
  }

  emit(ctx: Ctx): void {
    this.backend.emit?.(ctx);
    if (!this.issuing) return;
    for (const vm of this.vms) {
      const out = [...this.pending.values()].filter((r) => r.vm === vm).length;
      for (let i = 0; i < Math.min(this.perTick, this.depth - out); i++) this.submit(vm, ctx);
    }
  }

  onMessage(msg: Message, ctx: Ctx): void {
    this.backend.onMessage?.(msg, ctx);
  }

  tick(ctx: Ctx): void {
    this.backend.tick?.(ctx);
    for (const c of this.backend.drain()) {
      this.pending.delete(c.req.id);
      this.done.push(c);
    }
  }

  postTick(ctx: Ctx): void {
    this.backend.postTick?.(ctx);
  }

  onFail(ctx: Ctx): void {
    this.backend.onFail?.(ctx);
    this.pending.clear();
  }

  onRecover(ctx: Ctx): void {
    this.backend.onRecover?.(ctx);
  }

  /** Age of the oldest outstanding IO of `vm` (0 if none). */
  pendingS(vm: string, now: SimTime): number {
    let oldest = now;
    for (const r of this.pending.values())
      if (r.vm === vm && r.issuedAt < oldest) oldest = r.issuedAt;
    return now - oldest;
  }

  maxPendingS(now: SimTime): number {
    return Math.max(0, ...this.vms.map((v) => this.pendingS(v, now)));
  }

  completedAt(t: SimTime): IoCompletion[] {
    return this.done.filter((c) => c.completedAt === t);
  }

  errors(): IoCompletion[] {
    return this.done.filter((c) => c.outcome.status === 'error');
  }

  view(): DeviceView {
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      parent: this.parentId,
      status: 'healthy',
      badges: [],
      fields: { state: 'up', stargate: 'up', ...(this.backend.viewFields?.() ?? {}) },
    };
  }
}

export interface Loaded {
  readonly sim: ReturnType<typeof loadSimulation>['sim'];
  readonly part: ExternalStoragePart;
  readonly stubs: ReadonlyMap<string, StubCvm>;
  cvm(n: number): StubCvm;
  backend(n: number): ExternalStorageBackend;
  /** Every event so far. */
  events(code?: string): SimEvent[];
}

/** T1 / T1-lab through the real loader, with stub CVMs hosting this stream's backends. */
export function loadWithStubs(
  topologyId: TopologyId,
  options: OptionValues = {},
  io: StubIo = {},
): Loaded {
  let part: ExternalStoragePart | undefined;
  const stubs = new Map<string, StubCvm>();
  const { sim } = loadSimulation({
    topologyId,
    options,
    domain: ({ topology, versions }) => {
      const p = buildExternalStorage({ topology, profile: versions.profile });
      part = p;
      const cvms = topology.devices.filter((d) => d.kind === 'cvm');
      const cluster: ClusterView = {
        cvmIds: () => cvms.map((c) => c.id),
        isCvmUp: () => true,
        isStargateUp: () => true,
        cvmDataEndpoint: (c) => `${c}.mgmt`,
        cvmStorageEndpoints: (c) => p.facts.storageEndpoints.get(c) ?? [],
        zkQuorum: () => true,
        metadataAvailable: () => true,
        isHostFenced: () => false,
      };
      for (const c of cvms) {
        const vms = topology.devices
          .filter((d) => d.kind === 'vm' && d.parent === c.parent)
          .map((d) => d.id);
        const backend = p.backendFor(c.id);
        backend.attach(cluster);
        stubs.set(c.id, new StubCvm(c.id, c.parent ?? c.id, backend, vms, io));
      }
      return { devices: [...p.devices, ...stubs.values()], actions: p.actions };
    },
  });
  if (!part) throw new Error('domain factory did not run');
  const built = part;
  return {
    sim,
    part: built,
    stubs,
    cvm: (n) => {
      const s = stubs.get(`node-${n}.cvm`);
      if (!s) throw new Error(`no stub CVM node-${n}.cvm`);
      return s;
    },
    backend: (n) => built.backendFor(`node-${n}.cvm`),
    events: (code) => sim.eventLog().filter((e) => code === undefined || e.code === code),
  };
}

/** Path-state map of a CVM from the snapshot view (`nvmePaths`). */
export function pathsOf(sim: Loaded['sim'], cvm: string): Record<string, string> {
  const v = sim.getSnapshot().devices[cvm]?.fields.nvmePaths;
  return typeof v === 'string' ? (JSON.parse(v) as Record<string, string>) : {};
}

// ── Fake target for initiator unit tests ─────────────────────────────────────

export interface FakeTarget extends EngineDevice<Profile> {
  /** Stop/resume answering IO (admin still answered), like an array-wide pause. */
  pauseIo: boolean;
  /** Set an endpoint's admin state from inside the target (graceful close). */
  down: Set<string>;
  readonly ioSeen: Message[];
}

/** Answers NVMe/TCP admin and IO commands on every endpoint it owns. */
export function fakeTarget(id: string): FakeTarget {
  const ioSeen: Message[] = [];
  const held: Message[] = [];
  const reply = (msg: Message, ctx: Ctx, kind: string, payload: unknown) => {
    const e = asEngineContext(ctx);
    e.send({
      kind,
      src: msg.dst,
      dst: msg.src,
      size: 'small',
      flow: e.flow(msg.dst, msg.src, { srcPort: msg.flow.dstPort, dstPort: msg.flow.srcPort }),
      payload,
    });
  };
  const answer = (msg: Message, ctx: Ctx) => {
    const p = msg.payload as { key: string };
    reply(msg, ctx, msg.kind === NVME_MSG.io ? NVME_MSG.ioResp : NVME_MSG.resvResp, {
      key: p.key,
      status: 'ok',
      latencyMs: 0.1,
      heldS: 0,
    });
  };
  const t: FakeTarget = {
    id,
    kind: 'test-target',
    label: id,
    pauseIo: false,
    down: new Set(),
    ioSeen,
    preTick(ctx) {
      const e = asEngineContext(ctx);
      for (const ep of e.net.endpointsOf(id)) e.endpoints.setUp(ep.id, !t.down.has(ep.id));
    },
    emit(ctx) {
      if (t.pauseIo) return;
      for (const m of held.splice(0)) answer(m, ctx);
    },
    onMessage(msg, ctx) {
      if (msg.kind === NVME_MSG.keepAlive) reply(msg, ctx, NVME_MSG.keepAliveResp, msg.payload);
      else if (msg.kind === NVME_MSG.connect) {
        reply(msg, ctx, NVME_MSG.connectResp, { ...(msg.payload as object), ok: true });
      } else if (msg.kind === NVME_MSG.io || msg.kind === NVME_MSG.resv) {
        ioSeen.push(msg);
        if (t.pauseIo) held.push(msg);
        else answer(msg, ctx);
      }
    },
    view: () => ({ id, kind: 'test-target', label: id, status: 'healthy', badges: [], fields: {} }),
  };
  return t;
}
