/**
 * Fluid throughput and congestion model (pure; docs/research/link-congestion.md).
 *
 * The message layer samples a few IOs per tick to decide which paths and links carry storage
 * traffic. This layer gives that traffic a rate. It holds no rules about saturation, latency or
 * path shares; those come out of four mechanisms:
 *
 * 1. Every link direction has a line rate (full duplex) and a FIFO egress queue with a finite
 *    buffer. A queue delay `d` is the time to drain the bits ahead of a frame.
 * 2. Each flow (a VM's IO) is closed-loop: it keeps at most `outstandingBits` in flight (guest
 *    queue depth × IO size), so its rate on a path is outstanding / round-trip latency (Little's
 *    law), up to an optional offered-load cap.
 * 3. The multipath selector spreads that outstanding IO: `queue-depth` sends each new IO to the
 *    path with the fewest outstanding, which keeps outstanding equal per path; `round-robin`
 *    sends each path the same number of IOs, so the rate is equal per path; `single` uses one.
 * 4. Round-trip latency = base (array service + serialization + per-switch hop) + the queue
 *    delays of every link direction the path crosses, both ways (FIFO queues delay commands,
 *    data and acks alike).
 *
 * The network settles in milliseconds, far below a 1 s tick, so each tick solves for the
 * steady state: queue delays rise on a direction only while it is offered more than its line
 * rate, until the closed loops slow to fit (dual ascent, warm-started from the previous tick).
 * If a queue would need more delay than its buffer holds, the excess is dropped and the flows
 * through it are cut to what the link serves.
 */

/** A link direction: `<linkId>><from device>`. */
export type DirKey = string;

export const dirKey = (link: string, from: string): DirKey => `${link}>${from}`;

export interface DirCapacity {
  /** Line rate, bits per second. */
  readonly bps: number;
  /** Egress buffer, bits. */
  readonly bufferBits: number;
}

export interface FlowRoute {
  /** Share of the path's traffic on this route (connections hash onto routes). */
  readonly weight: number;
  /** Link directions host → array: write data, read commands. */
  readonly up: readonly DirKey[];
  /** Link directions array → host: read data, write acks. */
  readonly down: readonly DirKey[];
  /** Switches crossed one way (each adds the per-hop latency both ways). */
  readonly switchHops: number;
}

export interface FlowPath {
  readonly id: string;
  readonly routes: readonly FlowRoute[];
}

export type FlowSelector = 'queue-depth' | 'round-robin' | 'single';

export interface FlowDemand {
  readonly id: string;
  /** Offered-load cap, bits per second; `null` = none (the closed loop and the links limit it). */
  readonly capBps: number | null;
  /** Data the guest keeps in flight (queue depth × IO size), bits. */
  readonly outstandingBits: number;
  /** Fraction of the data that is read (array → host). */
  readonly readFraction: number;
  readonly selector: FlowSelector;
  readonly paths: readonly FlowPath[];
  /** Latency without queueing: array service time + serialization, seconds. */
  readonly baseLatencyS: number;
}

export interface FlowParams {
  /** Store-and-forward or cut-through latency per switch, one way, seconds. */
  readonly hopLatencyS: number;
  readonly iterations?: number;
}

export interface DirLoad {
  /** Bits per second the flows send into this direction. */
  readonly offeredBps: number;
  /** Bits per second it carries (offered, less what overflows the buffer). */
  readonly servedBps: number;
  readonly capacityBps: number;
  /** Steady-state queueing delay, seconds. */
  readonly delayS: number;
  /** Bits per second dropped because the buffer could not absorb the overload. */
  readonly dropBps: number;
}

export interface FlowResult {
  /** Achieved rate, bits per second (read + write). */
  readonly bps: number;
  /** Rate each path carries, bits per second. */
  readonly pathBps: Readonly<Record<string, number>>;
  /** Mean round-trip latency of an IO, seconds (weighted by the paths' rates). */
  readonly latencyS: number;
  /** Round-trip latency of an IO on each path, seconds. */
  readonly pathLatencyS: Readonly<Record<string, number>>;
}

export interface FlowSolution {
  readonly dirs: ReadonlyMap<DirKey, DirLoad>;
  readonly flows: ReadonlyMap<string, FlowResult>;
  /** Queue delays to warm-start the next tick. */
  readonly delays: ReadonlyMap<DirKey, number>;
}

interface Alloc {
  readonly pathBps: number[];
  readonly pathLatency: number[];
}

export function solveFlows(
  capacity: ReadonlyMap<DirKey, DirCapacity>,
  flows: readonly FlowDemand[],
  params: FlowParams,
  warm: ReadonlyMap<DirKey, number> = new Map(),
): FlowSolution {
  const dirs = [...capacity.keys()].sort();
  const d = new Map<DirKey, number>(dirs.map((k) => [k, warm.get(k) ?? 0]));
  const delay = (k: DirKey) => d.get(k) ?? 0;

  const routeLatency = (f: FlowDemand, r: FlowRoute) =>
    f.baseLatencyS +
    2 * r.switchHops * params.hopLatencyS +
    r.up.reduce((s, k) => s + delay(k), 0) +
    r.down.reduce((s, k) => s + delay(k), 0);

  const allocate = (f: FlowDemand): Alloc => {
    const lat = f.paths.map((p) => {
      const w = p.routes.reduce((s, r) => s + r.weight, 0) || 1;
      return p.routes.reduce((s, r) => s + (r.weight / w) * routeLatency(f, r), 0);
    });
    const n = f.paths.length;
    if (n === 0) return { pathBps: [], pathLatency: [] };
    let bps: number[];
    if (f.selector === 'single') {
      const x = f.outstandingBits / (lat[0] ?? 1);
      bps = [f.capBps === null ? x : Math.min(x, f.capBps), ...Array(n - 1).fill(0)];
    } else if (f.selector === 'round-robin') {
      // Equal IO rate per path; the slow path holds more of the outstanding IO.
      const sumLat = lat.reduce((s, l) => s + l, 0);
      const x = (f.outstandingBits * n) / sumLat;
      const total = f.capBps === null ? x : Math.min(x, f.capBps);
      bps = lat.map(() => total / n);
    } else {
      // Equal outstanding per path; each path completes outstanding / latency.
      const per = f.outstandingBits / n;
      const max = lat.map((l) => per / l);
      const total = max.reduce((s, x) => s + x, 0);
      const scale = f.capBps !== null && total > f.capBps ? f.capBps / total : 1;
      bps = max.map((x) => x * scale);
    }
    return { pathBps: bps, pathLatency: lat };
  };

  const loads = (allocs: readonly Alloc[], scaleOf?: (f: FlowDemand, p: number) => number) => {
    const a = new Map<DirKey, number>();
    flows.forEach((f, fi) => {
      const al = allocs[fi];
      if (!al) return;
      f.paths.forEach((p, pi) => {
        const x = (al.pathBps[pi] ?? 0) * (scaleOf ? scaleOf(f, pi) : 1);
        const w = p.routes.reduce((s, r) => s + r.weight, 0) || 1;
        for (const r of p.routes) {
          const share = (x * r.weight) / w;
          for (const k of r.up) a.set(k, (a.get(k) ?? 0) + share * (1 - f.readFraction));
          for (const k of r.down) a.set(k, (a.get(k) ?? 0) + share * f.readFraction);
        }
      });
    });
    return a;
  };

  const iterations = params.iterations ?? 400;
  let allocs = flows.map(allocate);
  for (let it = 0; it < iterations; it++) {
    const a = loads(allocs);
    let moved = false;
    for (const k of dirs) {
      const cap = capacity.get(k);
      if (!cap) continue;
      const ratio = (a.get(k) ?? 0) / cap.bps;
      const cur = delay(k);
      if (cur === 0 && ratio <= 1) continue;
      const dMax = cap.bufferBits / cap.bps;
      // Step relative to the delay itself (or a small floor), so the update is scale-free.
      const step = 0.5 * Math.max(cur, 1e-6);
      const next = Math.min(dMax, Math.max(0, cur + step * (ratio - 1)));
      if (Math.abs(next - cur) > 1e-12) moved = true;
      d.set(k, next);
    }
    allocs = flows.map(allocate);
    if (!moved) break;
  }

  // A direction still over its rate with a full buffer drops the excess: cut every flow through
  // it to the share the link serves (TCP backs off to the bottleneck).
  const offered = loads(allocs);
  const keep = new Map<DirKey, number>();
  for (const k of dirs) {
    const cap = capacity.get(k);
    const o = offered.get(k) ?? 0;
    if (cap && o > cap.bps * (1 + 1e-6)) keep.set(k, cap.bps / o);
  }
  const pathScale = (f: FlowDemand, pi: number) => {
    let s = 1;
    for (const r of f.paths[pi]?.routes ?? []) {
      for (const k of [...r.up, ...r.down]) s = Math.min(s, keep.get(k) ?? 1);
    }
    return s;
  };
  const served = loads(allocs, pathScale);

  const dirOut = new Map<DirKey, DirLoad>();
  for (const k of dirs) {
    const cap = capacity.get(k);
    if (!cap) continue;
    const o = offered.get(k) ?? 0;
    const sv = Math.min(served.get(k) ?? 0, cap.bps);
    dirOut.set(k, {
      offeredBps: o,
      servedBps: sv,
      capacityBps: cap.bps,
      delayS: delay(k),
      dropBps: Math.max(0, o - sv),
    });
  }
  const flowOut = new Map<string, FlowResult>();
  flows.forEach((f, fi) => {
    const al = allocs[fi];
    const pathBps: Record<string, number> = {};
    const pathLatencyS: Record<string, number> = {};
    let total = 0;
    let latW = 0;
    f.paths.forEach((p, pi) => {
      const x = (al?.pathBps[pi] ?? 0) * pathScale(f, pi);
      pathBps[p.id] = x;
      pathLatencyS[p.id] = al?.pathLatency[pi] ?? f.baseLatencyS;
      total += x;
      latW += x * (al?.pathLatency[pi] ?? 0);
    });
    flowOut.set(f.id, {
      bps: total,
      pathBps,
      latencyS: total > 0 ? latW / total : (al?.pathLatency[0] ?? f.baseLatencyS),
      pathLatencyS,
    });
  });
  return { dirs: dirOut, flows: flowOut, delays: d };
}
