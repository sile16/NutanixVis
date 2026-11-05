/**
 * Throughput meters for the diagram (pure), from the throughput model (`flow-data.ts`,
 * docs/research/link-congestion.md):
 *
 * - **Line rate** (NICs, array ports, the ISL): two small bars, one per direction, showing each
 *   direction's share of the cable's line rate.
 * - **Distribution** (under a bond / vSwitch): what share of the bond's traffic each member
 *   carries now.
 * - **Distribution** (under Stargate): what share of the CVM's storage traffic each of its storage
 *   interfaces (each set of NVMe paths) carries now, summed over every VM it serves.
 */
import type { Snapshot } from '../../engine/types';
import { stargateId } from './data-path';
import { linkUsage, nicLoad } from './flow-data';
import { bondMembers, isBondKind } from './path-usage';

export type MeterTone = 'ok' | 'busy' | 'full';

export interface DirMeter {
  /** Arrow for the direction as drawn: ↓ / ↑ (vertical cables), → / ← (the ISL). */
  readonly arrow: string;
  readonly gbps: number;
  /** Share of line rate, 0..1. */
  readonly util: number;
  readonly tone: MeterTone;
}

export interface LineMeter {
  readonly capacityGbps: number;
  readonly dirs: readonly DirMeter[];
}

export interface ShareSlice {
  readonly id: string;
  readonly label: string;
  /** 0..1 */
  readonly share: number;
}

export interface Meters {
  /** NIC / array-port id → its cable's two directions. ISL link id → its two directions. */
  readonly line: ReadonlyMap<string, LineMeter>;
  /** vSwitch id → share per member NIC. */
  readonly bond: ReadonlyMap<string, readonly ShareSlice[]>;
  /** Stargate box id → share per CVM storage interface. */
  readonly stargate: ReadonlyMap<string, readonly ShareSlice[]>;
}

const EMPTY: Meters = { line: new Map(), bond: new Map(), stargate: new Map() };

export const toneOf = (util: number, delayUs = 0): MeterTone =>
  delayUs > 2 || util >= 0.97 ? 'full' : util >= 0.8 ? 'busy' : 'ok';

/**
 * Hosts are drawn above the switches and the array below them (`layout.ts`), so a host NIC sends
 * down (↓) and receives up (↑), and an array port sends up and receives down.
 */
function arrows(kindOfParent: string | undefined): { out: string; in: string } {
  return kindOfParent === 'fa-controller' ? { out: '↑', in: '↓' } : { out: '↓', in: '↑' };
}

export function buildMeters(snapshot: Snapshot): Meters {
  const usage = linkUsage(snapshot);
  if (!usage) return EMPTY;
  const dev = snapshot.devices;
  const kind = (id: string) => dev[id]?.kind;
  const line = new Map<string, LineMeter>();
  const linkOf = new Map<string, string>();
  for (const l of Object.values(snapshot.links)) {
    linkOf.set(l.a.device, l.id);
    linkOf.set(l.b.device, l.id);
  }

  for (const [linkId, dirs] of usage) {
    if (dirs.length === 0) continue;
    const cap = dirs[0]?.capacityGbps ?? 0;
    const meter = (gbps: number, arrow: string, delayUs: number): DirMeter => {
      const util = cap > 0 ? gbps / cap : 0;
      return { arrow, gbps, util, tone: toneOf(util, delayUs) };
    };
    if (dirs.every((d) => kind(d.from) === 'switch' && kind(d.to) === 'switch')) {
      // Switch A is drawn left of Switch B.
      const sorted = [...dirs].sort((a, b) => a.from.localeCompare(b.from));
      line.set(linkId, {
        capacityGbps: cap,
        dirs: sorted.map((d, i) => meter(d.gbps, i === 0 ? '→' : '←', d.delayUs)),
      });
      continue;
    }
    const nic = dirs.find((d) => kind(d.from) !== 'switch')?.from;
    // An idle cable (e.g. the management vSwitch) gets no bars; the ISL always does.
    if (!nic || dirs.every((d) => d.gbps < 0.05)) continue;
    const x = nicLoad(dirs, nic);
    const into = dirs.find((d) => d.to === nic);
    const out = dirs.find((d) => d.from === nic);
    const parent = dev[nic]?.parent;
    const a = arrows(parent === undefined ? undefined : kind(parent));
    line.set(nic, {
      capacityGbps: cap,
      dirs: [
        meter(x?.outGbps ?? 0, a.out, out?.delayUs ?? 0),
        meter(x?.inGbps ?? 0, a.in, into?.delayUs ?? 0),
      ],
    });
  }

  const bond = new Map<string, ShareSlice[]>();
  for (const vs of Object.values(dev)) {
    if (!isBondKind(vs.kind)) continue;
    const members = bondMembers(vs);
    if (members.length < 2) continue;
    const load = members.map((nic) => {
      const x = nicLoad(usage.get(linkOf.get(nic) ?? ''), nic);
      return x ? x.inGbps + x.outGbps : 0;
    });
    const sum = load.reduce((s, v) => s + v, 0);
    if (sum <= 0) continue;
    bond.set(
      vs.id,
      members.map((nic, i) => ({
        id: nic,
        label: dev[nic]?.label ?? nic,
        share: (load[i] ?? 0) / sum,
      })),
    );
  }

  // Stargate: sum each VM's per-path Gb/s by the CVM storage interface the path leaves from.
  const perCvm = new Map<string, Map<string, number>>();
  for (const vm of Object.values(dev)) {
    if (vm.kind !== 'vm' || typeof vm.fields.ownerCvm !== 'string') continue;
    const raw = vm.fields.flowPaths;
    if (typeof raw !== 'string') continue;
    let paths: { id: string; gbps: number }[] = [];
    try {
      paths = JSON.parse(raw) as { id: string; gbps: number }[];
    } catch {
      continue;
    }
    const m = perCvm.get(vm.fields.ownerCvm) ?? new Map<string, number>();
    perCvm.set(vm.fields.ownerCvm, m);
    for (const p of paths) {
      const iface = p.id.split('~')[0] ?? '';
      m.set(iface, (m.get(iface) ?? 0) + p.gbps);
    }
  }
  const stargate = new Map<string, ShareSlice[]>();
  for (const [cvm, m] of perCvm) {
    // Every storage interface of the CVM, including one that carries nothing.
    const ifaces = Object.values(dev)
      .filter(
        (d) =>
          d.kind === 'cvm-interface' && d.parent === cvm && d.fields.service === 'external-storage',
      )
      .map((d) => d.id)
      .sort();
    const ids = ifaces.length > 0 ? ifaces : [...m.keys()].sort();
    const sum = ids.reduce((s, id) => s + (m.get(id) ?? 0), 0);
    if (sum <= 0) continue;
    stargate.set(
      stargateId(cvm),
      ids.map((id) => ({ id, label: dev[id]?.label ?? id, share: (m.get(id) ?? 0) / sum })),
    );
  }
  return { line, bond, stargate };
}
