/**
 * Storage throughput device (T1; docs/research/link-congestion.md). Gives the sampled storage IO
 * a rate and lets links congest:
 *
 * - Routes are learned, not assumed: every delivered NVMe/TCP IO frame and every iSCSI frame of
 *   the redirector this tick names the links it crossed, so MAC pinning, LACP hashing, failover
 *   and redirects all show up as they happen. Each (source, destination) pair keeps a decaying
 *   weight per distinct route.
 * - Each running VM is one closed-loop flow over the live NVMe paths of the CVM that serves it
 *   (`StorageBackend.flowPaths`), plus the redirect leg when that CVM is on another host.
 * - `solveFlows` (engine) turns line rates, buffers, guest queue depth and the path selector into
 *   link loads, queueing delays and per-VM rates. The queueing delays are handed back to the
 *   network, so later frames on a congested direction carry the extra latency, the NVMe
 *   initiator measures it, and its queue-depth selector sends less IO that way.
 */
import { asEngineContext, type EngineTrace } from '../../engine/context';
import {
  type DirCapacity,
  type DirKey,
  dirKey,
  type FlowDemand,
  type FlowRoute,
  type FlowSolution,
  solveFlows,
} from '../../engine/network/flow-solver';
import type { Device, DeviceView, ViewField } from '../../engine/types';
import type { Topology } from '../../topologies/schema';
import type { Ctx } from '../contracts';
import type { Profile } from '../versions/profile';
import { THROUGHPUT, WORKLOAD } from '../workload/io';
import type { Registry } from './registry';

export const FLOWS_DEVICE_ID = 'flows';

const DATA_CATEGORIES = new Set(['nvme-io', 'io-read', 'io-write']);
/**
 * Control frames that cross a path every tick (NVMe keep-alive, iSCSI NOP): they give a path a
 * route before its first sampled IO, at a weight too small to matter once IO routes are known.
 */
const CONTROL_CATEGORIES = new Set(['nvme-keepalive', 'iscsi-nop']);
const CONTROL_WEIGHT = 0.01;
/** Route weights decay per tick so a route no longer used fades out within a few ticks. */
const DECAY = 0.6;
const MIN_WEIGHT = 0.001;
const G = 1e9;

interface Learned {
  readonly dirs: readonly DirKey[];
  readonly links: readonly string[];
  readonly switchHops: number;
  weight: number;
}

interface DirInfo {
  readonly link: string;
  readonly from: string;
  readonly to: string;
}

export class FlowsDevice implements Device<Profile> {
  readonly id = FLOWS_DEVICE_ID;
  readonly kind = 'throughput-model';
  readonly label = 'Storage throughput';
  private readonly capacity = new Map<DirKey, DirCapacity>();
  private readonly dirInfo = new Map<DirKey, DirInfo>();
  private readonly ends = new Map<string, readonly [string, string]>();
  private readonly switches: ReadonlySet<string>;
  private readonly labels: ReadonlyMap<string, string>;
  private readonly parents: ReadonlyMap<string, string>;
  private readonly nics: ReadonlySet<string>;
  private readonly routes = new Map<string, Map<string, Learned>>();
  private warm: ReadonlyMap<DirKey, number> = new Map();
  private solution: FlowSolution | null = null;
  private readonly saturated = new Set<DirKey>();
  private readonly defaultLoad: { readonly gbps: number | null; readonly readPct: number };

  constructor(
    topology: Topology,
    private readonly reg: Registry,
  ) {
    const nicSpeed = new Map<string, number>();
    for (const d of topology.devices) if (d.kind === 'nic') nicSpeed.set(d.id, d.speedGbps);
    this.switches = new Set(topology.devices.filter((d) => d.kind === 'switch').map((d) => d.id));
    this.labels = new Map(topology.devices.map((d) => [d.id, d.label]));
    this.parents = new Map(topology.devices.flatMap((d) => (d.parent ? [[d.id, d.parent]] : [])));
    this.nics = new Set(nicSpeed.keys());
    const buffer = THROUGHPUT.portBufferMB.value * 8e6;
    for (const l of topology.links) {
      this.ends.set(l.id, [l.a, l.b]);
      const speeds = [nicSpeed.get(l.a), nicSpeed.get(l.b)].filter((x) => x !== undefined);
      const gbps = l.speedGbps ?? (speeds.length > 0 ? Math.min(...speeds) : undefined);
      if (gbps === undefined) continue;
      for (const [from, to] of [
        [l.a, l.b],
        [l.b, l.a],
      ] as const) {
        const k = dirKey(l.id, from);
        this.capacity.set(k, { bps: gbps * G, bufferBits: buffer });
        this.dirInfo.set(k, { link: l.id, from, to });
      }
    }
    const opt = (id: string) => {
      const o = topology.options.find((x) => x.id === id);
      return o?.value ?? o?.default;
    };
    const load = opt('vm-load-gbps');
    const read = opt('read-pct');
    this.defaultLoad = {
      gbps: typeof load === 'number' ? load : load === 'line-rate' ? null : 10,
      readPct: typeof read === 'number' ? read : 70,
    };
    reg.defaultReadPct = this.defaultLoad.readPct;
    reg.defaultGbps = this.defaultLoad.gbps;
  }

  postTick(ctx: Ctx): void {
    const e = asEngineContext(ctx);
    this.learn(e.traces());
    const flows = this.demands(ctx, (id) => e.net.link(id)?.status === 'up');
    const sol = solveFlows(
      this.capacity,
      flows,
      { hopLatencyS: THROUGHPUT.switchHopUs.value * 1e-6 },
      this.warm,
    );
    this.solution = sol;
    this.warm = sol.delays;
    const ms = new Map<string, number>();
    for (const [k, v] of sol.delays) if (v > 0) ms.set(k, v * 1000);
    e.setQueueDelays(ms);
    this.publish(flows, sol);
    this.events(ctx, sol);
  }

  /** Learn each (source → destination) pair's routes from this tick's delivered data frames. */
  private learn(traces: readonly EngineTrace[]): void {
    for (const m of this.routes.values()) {
      for (const [k, r] of m) {
        r.weight *= DECAY;
        if (r.weight < MIN_WEIGHT) m.delete(k);
      }
    }
    for (const t of traces) {
      const data = DATA_CATEGORIES.has(t.category);
      if (t.result !== 'delivered' || t.links.length === 0) continue;
      if (!data && !CONTROL_CATEGORIES.has(t.category)) continue;
      const w = data ? 1 : CONTROL_WEIGHT;
      const oriented = this.orient(t.links);
      if (!oriented) continue;
      const key = `${t.src}>${t.dst}`;
      const m = this.routes.get(key) ?? new Map<string, Learned>();
      this.routes.set(key, m);
      const rk = t.links.join(',');
      const r = m.get(rk);
      if (r) r.weight += w;
      else m.set(rk, { ...oriented, links: t.links, weight: w });
    }
  }

  /** Link directions of a trace, and the switches it crossed (consecutive links share a node). */
  private orient(links: readonly string[]): { dirs: DirKey[]; switchHops: number } | null {
    const first = this.ends.get(links[0] ?? '');
    if (!first) return null;
    const second = links[1] === undefined ? undefined : this.ends.get(links[1]);
    let node = second?.includes(first[0]) ? first[1] : first[0];
    const dirs: DirKey[] = [];
    let switchHops = 0;
    for (const id of links) {
      const ab = this.ends.get(id);
      if (!ab) return null;
      dirs.push(dirKey(id, node));
      node = ab[0] === node ? ab[1] : ab[0];
      if (this.switches.has(node)) switchHops++;
    }
    return { dirs, switchHops };
  }

  private learned(src: string, dst: string, up: (link: string) => boolean): Learned[] {
    return [...(this.routes.get(`${src}>${dst}`)?.values() ?? [])].filter((r) => r.links.every(up));
  }

  private loadOf(vm: string) {
    return this.reg.vmLoad.get(vm) ?? this.defaultLoad;
  }

  private demands(ctx: Ctx, up: (link: string) => boolean): FlowDemand[] {
    const reg = this.reg;
    const qd = reg.facts.guestQueueDepth ?? WORKLOAD.queueDepth.value;
    const ioBits = THROUGHPUT.ioSizeKiB.value * 1024 * 8;
    const svc = ctx.profile.flasharray.serviceTimeMs.value;
    const out: FlowDemand[] = [];
    for (const vm of [...reg.vms.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const host = vm.host;
      const vdisk = vm.vdisks[0];
      // Only a VM whose IO completes carries throughput: off, crashed, restarting, paused and
      // io-stalled VMs (a hung Stargate, an array IO stall) move no data. This device runs before
      // the VMs' `postTick` (id order), so it reads their state for this tick directly.
      if (host === null || vdisk === undefined || vm.stateAt(ctx.now) !== 'running') continue;
      const cvm = reg.ownerCvm(vdisk);
      const set = cvm === null ? undefined : reg.backends.get(cvm)?.flowPaths?.(vdisk);
      if (cvm === null || !set || set.paths.length === 0) continue;
      // Redirect leg: the VM's host to a CVM on another host (iSCSI over the management network).
      let legUp: Learned[] = [];
      let legDown: Learned[] = [];
      if (reg.cvmHost(cvm) !== host) {
        const h = reg.facts.host(host)?.mgmtEndpoint;
        const c = reg.facts.cvm(cvm)?.mgmtEndpoint;
        if (!h || !c) continue;
        legUp = this.learned(h, c, up);
        legDown = this.learned(c, h, up);
        if (legUp.length === 0 || legDown.length === 0) continue;
      }
      // A path whose route is not known (yet, or no longer: a tick or two after a start, a
      // failover, a redirect, or a switch failure before the initiator drops the path) carries
      // nothing; the VM's flow runs over the paths that do have a route.
      const paths = set.paths.flatMap((p) => {
        const ups = this.learned(p.local, p.remote, up);
        const downs = this.learned(p.remote, p.local, up);
        if (ups.length === 0 || downs.length === 0) return [];
        return [{ id: p.id, routes: combine(legUp, ups, downs, legDown) }];
      });
      if (paths.length === 0) continue;
      const load = this.loadOf(vm.id);
      // A partial stall: stuck IO holds part of the guest's queue slots, so only the rest is
      // in flight on the live paths (closed loop).
      const free = Math.max(0, 100 - vm.stuckIoPctAt(ctx.now)) / 100;
      if (free === 0) continue;
      const r = load.readPct / 100;
      const slowest = Math.min(
        ...paths.flatMap((p) =>
          p.routes.flatMap((rt) =>
            [...rt.up, ...rt.down].map((k) => this.capacity.get(k)?.bps ?? Infinity),
          ),
        ),
      );
      out.push({
        id: vm.id,
        capBps: load.gbps === null ? null : load.gbps * G,
        outstandingBits: qd * ioBits * vm.vdisks.length * free,
        readFraction: r,
        selector: set.selector,
        paths,
        // Array service time (illustrative, profile) plus putting one IO on the slowest link.
        baseLatencyS:
          (r * svc.read + (1 - r) * svc.write) / 1000 +
          (Number.isFinite(slowest) ? ioBits / slowest : 0),
      });
    }
    return out;
  }

  /** `Node 1 eth2`, `CT0 eth10`, `Switch A`: a device as a route reads it. */
  private hopName(id: string): string {
    const own = this.labels.get(id) ?? id;
    const parent = this.parents.get(id);
    return parent !== undefined && this.nics.has(id)
      ? `${this.labels.get(parent) ?? parent} ${own}`
      : own;
  }

  /** `Node 1 eth2 → Switch A ⇒ Switch B [full +120 µs] → CT0 eth11` for a list of directions. */
  private describe(dirs: readonly DirKey[], sol: FlowSolution): string {
    const first = this.dirInfo.get(dirs[0] ?? '');
    if (!first) return '';
    let out = this.hopName(first.from);
    for (const k of dirs) {
      const info = this.dirInfo.get(k);
      if (!info) continue;
      const d = sol.dirs.get(k);
      const isl = this.switches.has(info.from) && this.switches.has(info.to);
      const full = d && this.isSaturated(k, sol) ? ` [full +${Math.round(d.delayS * 1e6)} µs]` : '';
      out += `${isl ? ' ⇒ ISL ⇒ ' : ' → '}${this.hopName(info.to)}${full}`;
    }
    return out;
  }

  private publish(flows: readonly FlowDemand[], sol: FlowSolution): void {
    this.reg.vmFlow.clear();
    const ioBits = THROUGHPUT.ioSizeKiB.value * 1024 * 8;
    const crossesIsl = (k: DirKey) => {
      const info = this.dirInfo.get(k);
      return !!info && this.switches.has(info.from) && this.switches.has(info.to);
    };
    for (const f of flows) {
      const res = sol.flows.get(f.id);
      if (!res) continue;
      const paths = f.paths.map((p) => {
        const total = p.routes.reduce((s, r) => s + r.weight, 0) || 1;
        const byText = new Map<string, number>();
        let isl = 0;
        for (const r of p.routes) {
          const key = `${this.describe(r.up, sol)}|${this.describe(r.down, sol)}`;
          byText.set(key, (byText.get(key) ?? 0) + r.weight / total);
          if ([...r.up, ...r.down].some(crossesIsl)) isl += r.weight / total;
        }
        return {
          id: p.id,
          gbps: round1((res.pathBps[p.id] ?? 0) / G),
          latencyUs: Math.round((res.pathLatencyS[p.id] ?? 0) * 1e6),
          islPct: Math.round(isl * 100),
          routes: [...byText]
            .sort((a, b) => b[1] - a[1])
            .map(([k, w]) => {
              const [out = '', back = ''] = k.split('|');
              return { pct: Math.round(w * 100), out, back };
            }),
        };
      });
      const load = this.loadOf(f.id);
      this.reg.vmFlow.set(f.id, {
        offeredGbps: load.gbps,
        offeredIops: load.gbps === null ? null : (load.gbps * G) / ioBits,
        iops: res.bps / ioBits,
        readPct: load.readPct,
        gbps: res.bps / G,
        readGbps: (res.bps * f.readFraction) / G,
        writeGbps: (res.bps * (1 - f.readFraction)) / G,
        latencyUs: res.latencyS * 1e6,
        paths,
      });
    }
    // Every other VM: no rate now, but its offered load (the `vm.set-load` form shows it).
    for (const vm of this.reg.vms.values()) {
      if (this.reg.vmFlow.has(vm.id)) continue;
      const load = this.loadOf(vm.id);
      this.reg.vmFlow.set(vm.id, {
        offeredGbps: load.gbps,
        offeredIops: load.gbps === null ? null : (load.gbps * G) / ioBits,
        iops: 0,
        readPct: load.readPct,
        gbps: 0,
        readGbps: 0,
        writeGbps: 0,
        latencyUs: 0,
        paths: [],
      });
    }
  }

  /** Whether the saturation event fires: queueing delay above a couple of µs, or drops. */
  private isSaturated(k: DirKey, sol: FlowSolution): boolean {
    const d = sol.dirs.get(k);
    if (!d) return false;
    if (this.saturated.has(k)) return d.delayS > 0 || d.servedBps >= 0.97 * d.capacityBps;
    return d.delayS > 2e-6 || d.dropBps > 0;
  }

  private events(ctx: Ctx, sol: FlowSolution): void {
    for (const k of [...this.capacity.keys()].sort()) {
      const was = this.saturated.has(k);
      const is = this.isSaturated(k, sol);
      if (was === is) continue;
      const info = this.dirInfo.get(k);
      const d = sol.dirs.get(k);
      if (!info || !d) continue;
      const dir = `${this.labels.get(info.from) ?? info.from} → ${this.labels.get(info.to) ?? info.to}`;
      if (is) {
        this.saturated.add(k);
        ctx.emit({
          severity: 'warn',
          deviceId: info.link,
          code: 'net.link.saturated',
          text: `${dir} is at line rate (${Math.round(d.capacityBps / G)} Gb/s): ${saturationEffect(d)}`,
          causeIds: [],
          cite: [],
          confidence: 'assumption',
        });
      } else {
        this.saturated.delete(k);
        ctx.emit({
          severity: 'info',
          deviceId: info.link,
          code: 'net.link.unsaturated',
          text: `${dir} is below line rate again`,
          causeIds: [],
          cite: [],
          confidence: 'assumption',
        });
      }
    }
  }

  view(): DeviceView {
    const links: Record<
      string,
      {
        from: string;
        to: string;
        gbps: number;
        capacityGbps: number;
        delayUs: number;
        dropGbps: number;
      }[]
    > = {};
    for (const [k, d] of this.solution?.dirs ?? []) {
      const info = this.dirInfo.get(k);
      if (!info) continue;
      const list = links[info.link] ?? [];
      links[info.link] = list;
      list.push({
        from: info.from,
        to: info.to,
        gbps: round1(d.servedBps / G),
        capacityGbps: d.capacityBps / G,
        delayUs: Math.round(d.delayS * 1e6 * 10) / 10,
        dropGbps: round1(d.dropBps / G),
      });
    }
    const fields: Record<string, ViewField> = {
      links: JSON.stringify(links),
      saturated: JSON.stringify([...this.saturated].sort()),
    };
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      status: this.saturated.size > 0 ? 'degraded' : 'healthy',
      badges: [],
      fields,
    };
  }
}

/** Every combination of leg and path routes, weighted by the product of their shares. */
function combine(
  legUp: readonly Learned[],
  ups: readonly Learned[],
  downs: readonly Learned[],
  legDown: readonly Learned[],
): FlowRoute[] {
  const norm = (xs: readonly Learned[]) => {
    const t = xs.reduce((s, x) => s + x.weight, 0);
    return xs.length === 0 ? [null] : xs.map((x) => ({ x, w: x.weight / t }));
  };
  const out: FlowRoute[] = [];
  for (const lu of norm(legUp)) {
    for (const u of norm(ups)) {
      for (const d of norm(downs)) {
        for (const ld of norm(legDown)) {
          const w = (lu?.w ?? 1) * (u?.w ?? 1) * (d?.w ?? 1) * (ld?.w ?? 1);
          out.push({
            weight: w,
            up: [...(lu?.x.dirs ?? []), ...(u?.x.dirs ?? [])],
            down: [...(d?.x.dirs ?? []), ...(ld?.x.dirs ?? [])],
            switchHops:
              ((lu?.x.switchHops ?? 0) +
                (u?.x.switchHops ?? 0) +
                (d?.x.switchHops ?? 0) +
                (ld?.x.switchHops ?? 0)) /
              2,
          });
        }
      }
    }
  }
  return out;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * What a saturated direction does to the IO through it: the queueing delay it adds, or (when its
 * buffer is full and the delay rounds to nothing) the frames it drops, which the senders retry.
 */
function saturationEffect(d: { readonly delayS: number; readonly dropBps: number }): string {
  const us = Math.round(d.delayS * 1e6);
  if (us >= 1) return `its queue adds about ${us} µs, and IO through it slows`;
  if (d.dropBps > 0) return 'it drops the excess frames, and the senders slow down to fit';
  return 'IO through it is capped at the line rate';
}
