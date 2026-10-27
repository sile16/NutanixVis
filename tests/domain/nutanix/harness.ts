/**
 * Headless harness for stream F: loads a real topology through `loadSimulation` with the Nutanix
 * domain and a fake `StorageBackend` per CVM (instant completions, controllable health).
 */
import type {
  ClusterView,
  Ctx,
  IoCompletion,
  IoRequest,
  StorageBackend,
} from '../../../src/domain/contracts';
import { createNutanixDomain } from '../../../src/domain/nutanix';
import type { NutanixClusterView } from '../../../src/domain/nutanix/registry';
import type { EngineSimulation } from '../../../src/engine/sim';
import type { DeviceView, SimEvent, Snapshot, ViewField } from '../../../src/engine/types';
import { loadSimulation } from '../../../src/loader/simulation';
import type { OptionValues, TopologyId } from '../../../src/topologies';

export class FakeBackend implements StorageBackend {
  readonly name = 'fake-backend';
  state: 'ok' | 'degraded' | 'unavailable' = 'ok';
  /** Writes fail terminally while set (exercise IO error paths). */
  failWrites = false;
  readonly acquired = new Set<string>();
  readonly submitted: IoRequest[] = [];
  private held: IoRequest[] = [];
  private done: IoCompletion[] = [];
  cluster: ClusterView | null = null;
  attachCount = 0;
  /** Hook calls, for delegation tests. */
  readonly calls = { preTick: 0, emit: 0, tick: 0, postTick: 0, onFail: 0, onRecover: 0 };
  /** Returned from `derived()` (e.g. stream G's `hci.*` keys). */
  extraDerived: Record<string, ViewField> = {};

  constructor(
    readonly kind: 'external-nvme' | 'hci',
    readonly cvm: string,
  ) {}

  attach(cluster: ClusterView): void {
    this.cluster = cluster;
    this.attachCount++;
  }
  acquire(vdisk: string): void {
    this.acquired.add(vdisk);
  }
  release(vdisk: string): void {
    this.acquired.delete(vdisk);
  }
  submit(req: IoRequest, ctx: Ctx): void {
    this.submitted.push(req);
    if (this.state === 'unavailable') this.held.push(req);
    else this.complete(req, ctx.now);
  }
  drain(): readonly IoCompletion[] {
    const out = this.done;
    this.done = [];
    return out;
  }
  health(): 'ok' | 'degraded' | 'unavailable' {
    return this.state;
  }
  pathsFor(): readonly string[] {
    if (this.kind !== 'external-nvme' || this.state === 'unavailable') return [];
    return [`${this.cvm}.storage-a~fa.ct0.eth10.v10`];
  }
  preTick(): void {
    this.calls.preTick++;
  }
  emit(): void {
    this.calls.emit++;
  }
  postTick(): void {
    this.calls.postTick++;
  }
  onRecover(): void {
    this.calls.onRecover++;
  }
  derived(): Readonly<Record<string, ViewField>> {
    return this.extraDerived;
  }
  tick(ctx: Ctx): void {
    this.calls.tick++;
    if (this.state === 'unavailable') return;
    const held = this.held;
    this.held = [];
    for (const r of held) this.complete(r, ctx.now);
  }
  onFail(): void {
    this.calls.onFail++;
    // In-flight IO on a failed Stargate is dropped, not errored (as stream G's backend does).
    this.held = [];
    this.done = [];
  }
  viewFields(): Readonly<Record<string, ViewField>> {
    if (this.kind !== 'external-nvme') return {};
    const up = this.state === 'unavailable' ? 0 : 1;
    return {
      nvmePathsUp: up,
      nvmePathsTotal: 1,
      nvmePaths: JSON.stringify({
        [`${this.cvm}.storage-a~fa.ct0.eth10.v10`]: up ? 'live' : 'lost',
      }),
    };
  }
  private complete(req: IoRequest, now: number): void {
    if (this.failWrites && req.op === 'write') {
      this.done.push({ req, outcome: { status: 'error', reason: 'test' }, completedAt: now });
      return;
    }
    this.done.push({ req, outcome: { status: 'ok', latencyMs: 1 }, completedAt: now });
  }
}

export interface Harness {
  readonly sim: EngineSimulation;
  readonly backends: ReadonlyMap<string, FakeBackend>;
  readonly cluster: NutanixClusterView;
  /** Every event so far. */
  events(): readonly SimEvent[];
  s(): Snapshot;
  dev(id: string): DeviceView;
  f(id: string, key: string): ViewField | undefined;
  d(key: string): unknown;
  /** Queue an action and run `ticks` ticks. */
  act(kind: string, target: string, params?: Record<string, string | number | boolean>): void;
  run(ticks: number): Snapshot;
  /** First tick (≥ from) an event with code (and device) appeared, or null. */
  firstAt(code: string, device?: string, from?: number): number | null;
  /** Run tick by tick until pred holds (max ticks); returns the tick or null. */
  until(pred: (s: Snapshot) => boolean, max: number): number | null;
}

export function harness(topologyId: TopologyId, options: OptionValues = {}, seed = 1): Harness {
  const backends = new Map<string, FakeBackend>();
  let cluster: NutanixClusterView | undefined;
  const { sim } = loadSimulation({
    topologyId,
    options,
    seed,
    domain: ({ topology, versions }) => {
      const kind =
        topology.family === 't1' || topology.family === 't1-lab' ? 'external-nvme' : 'hci';
      const part = createNutanixDomain({
        topology,
        profile: versions.profile,
        backendFor: (cvm) => {
          const b = new FakeBackend(kind, cvm);
          backends.set(cvm, b);
          return b;
        },
      });
      cluster = part.cluster as NutanixClusterView;
      return part;
    },
  });
  if (!cluster) throw new Error('domain not built');
  const c = cluster;
  const h: Harness = {
    sim,
    backends,
    cluster: c,
    events: () => sim.eventLog(),
    s: () => sim.getSnapshot(),
    dev: (id) => {
      const d = sim.getSnapshot().devices[id];
      if (!d) throw new Error(`no device ${id}`);
      return d;
    },
    f: (id, key) => h.dev(id).fields[key],
    d: (key) => sim.getSnapshot().derived[key],
    act: (kind, target, params) => sim.applyAction({ kind, target, ...(params ? { params } : {}) }),
    run: (ticks) => sim.tick(ticks),
    firstAt: (code, device, from = 0) =>
      sim
        .eventLog()
        .find(
          (e) => e.code === code && e.t >= from && (device === undefined || e.deviceId === device),
        )?.t ?? null,
    until: (pred, max) => {
      for (let i = 0; i < max; i++) {
        const s = sim.tick(1);
        if (pred(s)) return s.simTime;
      }
      return null;
    },
  };
  return h;
}

export const vmState = (h: Harness, id: string): string => String(h.f(id, 'state'));
export const vmHost = (h: Harness, id: string): string | null =>
  (h.f(id, 'host') as string | null) ?? null;
export const instances = (h: Harness, id: string): string[] =>
  JSON.parse(String(h.f(id, 'instances'))) as string[];
export const vmIds = (h: Harness): string[] =>
  Object.values(h.s().devices)
    .filter((d) => d.kind === 'vm')
    .map((d) => d.id)
    .sort();
