/**
 * Test doubles so the HCI data path runs headless without stream F:
 * - `FakeCluster`: a `ClusterView` whose CVM/Stargate state comes from the stub CVMs, with
 *   metadata = a majority of ring members up (members down ≥ `cassandraRingDetachS` detach).
 * - `StubCvm`: a CVM device that hosts the HCI backend, delegates hooks/messages to it, and
 *   submits a steady IO stream (one outstanding read + one write per VM) for the VMs it serves.
 *   A VM is served by its home CVM when that Stargate is up, else by the first serving CVM.
 */

import type { ClusterView, IoCompletion, StorageBackend } from '../../../src/domain/contracts';
import {
  createHciDomain,
  HciBackend,
  type HciStore,
  readLayout,
} from '../../../src/domain/nutanix/hci';
import type { Profile } from '../../../src/domain/versions/profile';
import { asEngineContext, type EngineDevice } from '../../../src/engine/context';
import type {
  DeviceId,
  DeviceView,
  Message,
  Snapshot,
  TickContext,
  ViewField,
} from '../../../src/engine/types';
import { type LoadedSimulation, loadSimulation } from '../../../src/loader/simulation';
import type { OptionValues, TopologyId } from '../../../src/topologies';

type Ctx = TickContext<Profile>;

export class FakeCluster implements ClusterView {
  readonly cvms = new Map<DeviceId, StubCvm>();
  readonly stargateStopped = new Set<DeviceId>();
  metadataOverride: boolean | undefined;
  now = 0;

  constructor(private readonly ringDetachS: number) {}

  cvmIds(): readonly DeviceId[] {
    return [...this.cvms.keys()].sort();
  }
  isCvmUp(cvm: DeviceId): boolean {
    return this.cvms.get(cvm)?.up ?? false;
  }
  isStargateUp(cvm: DeviceId): boolean {
    return this.isCvmUp(cvm) && !this.stargateStopped.has(cvm);
  }
  cvmDataEndpoint(cvm: DeviceId): string {
    return `${cvm}.mgmt`;
  }
  cvmStorageEndpoints(): readonly string[] {
    return [];
  }
  zkQuorum(): boolean {
    return this.metadataAvailable();
  }
  metadataAvailable(): boolean {
    if (this.metadataOverride !== undefined) return this.metadataOverride;
    const members = [...this.cvms.values()].filter(
      (c) => c.up || this.now - c.downSince < this.ringDetachS,
    );
    const up = members.filter((c) => c.up).length;
    return up * 2 > members.length;
  }
  isHostFenced(): boolean {
    return false;
  }
}

export interface VmStats {
  readonly vm: DeviceId;
  readonly host: DeviceId;
  readonly vdisk: string;
  readonly home: DeviceId;
  writes: number;
  reads: number;
  errors: string[];
  outstanding: Map<'read' | 'write', { at: number; by: DeviceId }>;
  servedBy: DeviceId[];
}

export class Workload {
  readonly vms: VmStats[] = [];
  private seq = 0;

  constructor(private readonly cluster: FakeCluster) {}

  server(v: VmStats): DeviceId | undefined {
    if (this.cluster.isStargateUp(v.home)) return v.home;
    return this.cluster.cvmIds().find((c) => this.cluster.isStargateUp(c));
  }

  nextId(vm: DeviceId, op: string): string {
    return `${vm}.${op}.${++this.seq}`;
  }

  record(c: IoCompletion): void {
    const v = this.vms.find((x) => x.vm === c.req.vm);
    if (!v) return;
    v.outstanding.delete(c.req.op);
    if (c.outcome.status === 'error') v.errors.push(c.outcome.reason);
    else if (c.req.op === 'write') v.writes++;
    else v.reads++;
  }

  /** Age of the oldest outstanding IO of any VM (the "hang" measure). */
  maxPendingS(now: number): number {
    let max = 0;
    for (const v of this.vms)
      for (const o of v.outstanding.values()) max = Math.max(max, now - o.at);
    return max;
  }

  totals(): { writes: number; reads: number; errors: number } {
    let writes = 0;
    let reads = 0;
    let errors = 0;
    for (const v of this.vms) {
      writes += v.writes;
      reads += v.reads;
      errors += v.errors.length;
    }
    return { writes, reads, errors };
  }
}

export class StubCvm implements EngineDevice<Profile> {
  readonly kind = 'cvm';
  readonly label: string;
  up = true;
  downSince = Number.POSITIVE_INFINITY;

  constructor(
    readonly id: DeviceId,
    readonly parentId: DeviceId,
    readonly backend: StorageBackend,
    private readonly cluster: FakeCluster,
    private readonly workload: Workload,
  ) {
    this.label = id;
  }

  preTick(ctx: Ctx): void {
    this.cluster.now = ctx.now;
    this.backend.preTick?.(ctx);
  }

  emit(ctx: Ctx): void {
    if (!this.cluster.isStargateUp(this.id)) return;
    const e = asEngineContext(ctx);
    for (const v of this.workload.vms) {
      if (!e.isUp(v.vm)) continue;
      // Retry IO whose Stargate went away (the redirector re-login, simplified).
      for (const [op, o] of [...v.outstanding]) {
        if (!this.cluster.isStargateUp(o.by)) v.outstanding.delete(op);
      }
      if (this.workload.server(v) !== this.id) continue;
      for (const op of ['write', 'read'] as const) {
        if (v.outstanding.has(op)) continue;
        v.outstanding.set(op, { at: ctx.now, by: this.id });
        if (v.servedBy.at(-1) !== this.id) v.servedBy.push(this.id);
        this.backend.submit(
          {
            id: this.workload.nextId(v.vm, op),
            vdisk: v.vdisk,
            vm: v.vm,
            op,
            size: 'large',
            issuedAt: ctx.now,
          },
          ctx,
        );
      }
    }
    this.backend.emit?.(ctx);
  }

  onMessage(msg: Message, ctx: Ctx): void {
    this.backend.onMessage?.(msg, ctx);
  }

  tick(ctx: Ctx): void {
    this.backend.tick?.(ctx);
  }

  postTick(ctx: Ctx): void {
    this.backend.postTick?.(ctx);
    for (const c of this.backend.drain()) this.workload.record(c);
  }

  onFail(ctx: Ctx): void {
    this.up = false;
    this.downSince = ctx.now;
    this.backend.onFail?.(ctx);
  }

  onRecover(ctx: Ctx): void {
    this.up = true;
    this.downSince = Number.POSITIVE_INFINITY;
    this.backend.onRecover?.(ctx);
  }

  view(): DeviceView {
    const fields: Record<string, ViewField> = {
      state: this.up ? 'up' : 'down',
      stargate: this.cluster.isStargateUp(this.id) ? 'up' : 'down',
      ...this.backend.viewFields?.(),
    };
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      parent: this.parentId,
      status: this.up ? 'healthy' : 'failed',
      badges: [],
      fields,
    };
  }

  derived(): Readonly<Record<string, ViewField>> {
    return this.backend.derived?.() ?? {};
  }
}

export interface Harness extends LoadedSimulation {
  readonly cluster: FakeCluster;
  readonly workload: Workload;
  readonly backends: ReadonlyMap<DeviceId, StorageBackend>;
  readonly store: HciStore;
  derived(): Snapshot['derived'];
  disk(id: string): Readonly<Record<string, ViewField>>;
  events(code: string): ReturnType<LoadedSimulation['sim']['eventLog']>;
}

/** T2/T3 via `loadSimulation` with the HCI domain, stub CVMs and a fake cluster view. */
export function harness(topologyId: TopologyId, options: OptionValues = {}): Harness {
  let cluster: FakeCluster | undefined;
  let workload: Workload | undefined;
  const backends = new Map<DeviceId, StorageBackend>();
  const loaded = loadSimulation({
    topologyId,
    options,
    domain: ({ topology, versions }) => {
      const profile = versions.profile;
      const hci = createHciDomain({ topology, profile });
      const fc = new FakeCluster(profile.cluster.cassandraRingDetachS.value);
      const wl = new Workload(fc);
      const layout = readLayout(topology);
      const hostOfVm = new Map(topology.devices.map((d) => [d.id, d.parent ?? d.id]));
      for (const v of layout.vdisks) {
        wl.vms.push({
          vm: v.vm,
          host: hostOfVm.get(v.vm) ?? v.vm,
          vdisk: v.id,
          home: v.home,
          writes: 0,
          reads: 0,
          errors: [],
          outstanding: new Map(),
          servedBy: [],
        });
      }
      const cvms = layout.nodes.map((n) => {
        const b = hci.backendFor(n.cvm);
        backends.set(n.cvm, b);
        const stub = new StubCvm(n.cvm, n.host, b, fc, wl);
        fc.cvms.set(n.cvm, stub);
        return stub;
      });
      for (const b of backends.values()) b.attach(fc);
      cluster = fc;
      workload = wl;
      return { devices: [...hci.devices, ...cvms], actions: hci.actions ?? [] };
    },
  });
  if (!cluster || !workload) throw new Error('domain factory did not run');
  const sim = loaded.sim;
  const first = [...backends.values()][0];
  if (!(first instanceof HciBackend)) throw new Error('expected an HCI backend');
  return {
    store: first.store,
    ...loaded,
    cluster,
    workload,
    backends,
    derived: () => sim.getSnapshot().derived,
    disk: (id) => sim.getSnapshot().devices[id]?.fields ?? {},
    events: (code) => sim.eventLog().filter((e) => e.code === code),
  };
}
