/**
 * Path-usage view (SPEC §6.4b). Pure functions over a `Snapshot`.
 *
 * Per VM: a VM's `ioPaths` (NVMe path ids, `cvmIface~faIface`) and `ioUplinks` view fields name
 * the paths and NICs its vDisk IO used (docs/view-fields.md), so traces are matched by endpoints.
 * Fallback per host: an HCI VM served locally over virbr0 has no network path at all, so its view
 * is the storage traffic that starts or ends on its host's NICs.
 */
import type { DeviceView, LinkView, Snapshot, Trace, TrafficCategory } from '../../engine/types';
import { isStorageCategory } from './traffic';

export interface Share {
  readonly linkId: string;
  readonly deviceId: string;
  readonly label: string;
  readonly count: number;
  /** count / total of this group, 0..1 */
  readonly share: number;
  readonly status: LinkView['status'];
}

export interface PathUsage {
  readonly vmId: string;
  readonly hostId: string | undefined;
  readonly cvmId: string | undefined;
  /** `vm`: only this VM's own paths; `host`: every storage trace of its host (fallback). */
  readonly scope: 'vm' | 'host';
  readonly linkIds: ReadonlySet<string>;
  readonly deviceIds: ReadonlySet<string>;
  /** Host uplinks (NIC cables) carrying this VM's storage traffic. */
  readonly uplinks: readonly Share[];
  /** Far-end ports (e.g. FlashArray FE ports) the traffic lands on. */
  readonly targets: readonly Share[];
  readonly traceCount: number;
}

export function ancestorOfKind(
  devices: Snapshot['devices'],
  id: string,
  kind: string,
): DeviceView | undefined {
  let cur = devices[id];
  while (cur) {
    if (cur.kind === kind) return cur;
    cur = cur.parent ? devices[cur.parent] : undefined;
  }
  return undefined;
}

export function isDescendant(devices: Snapshot['devices'], id: string, ancestor: string): boolean {
  let cur = devices[id];
  while (cur) {
    if (cur.id === ancestor) return true;
    cur = cur.parent ? devices[cur.parent] : undefined;
  }
  return false;
}

/** Device kinds that are a host's virtual switch / bond (the engine view uses `bond`). */
export const isBondKind = (kind: string): boolean => kind === 'vswitch' || kind === 'bond';

/** A bond's member NICs: `uplinks` (comma list) or `members` (JSON list). */
export function bondMembers(d: DeviceView): string[] {
  const csv = d.fields.uplinks;
  if (typeof csv === 'string' && csv.trim() !== '') {
    return csv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const json = d.fields.members;
  if (typeof json !== 'string') return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const deviceLabel = (devices: Snapshot['devices'], id: string): string => {
  const d = devices[id];
  if (!d) return id;
  const parent = d.parent ? devices[d.parent] : undefined;
  return parent && d.kind === 'nic' ? `${parent.label} ${d.label}` : d.label;
};

function shares(
  counts: Map<string, { deviceId: string; count: number }>,
  snapshot: Snapshot,
): Share[] {
  const total = [...counts.values()].reduce((s, c) => s + c.count, 0);
  return [...counts.entries()]
    .map(([linkId, c]) => ({
      linkId,
      deviceId: c.deviceId,
      label: deviceLabel(snapshot.devices, c.deviceId),
      count: c.count,
      share: total > 0 ? c.count / total : 0,
      status: snapshot.links[linkId]?.status ?? 'down',
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Data IO (no health checks or keep-alives): what a single VM's paths carry. */
const isIoCategory = (c: string): boolean => c.startsWith('io-') || c === 'nvme-io';

/** A VM's own IO over the activity window (`ActivityWindow.vmPaths`). */
export interface VmIo {
  readonly paths: ReadonlySet<string>;
  readonly uplinks: ReadonlySet<string>;
}

/**
 * Path usage for a VM. With `vmIo` (its `ioPaths` / `ioUplinks` view fields over the window) only
 * that VM's own traffic is counted: NVMe/TCP traces whose `src~dst` is one of its paths (T1), or
 * IO traces between its host and its owning CVM over one of its uplinks (CO nodes, redirects).
 * Without them (HCI VMs served locally over virbr0) it falls back to the host's storage traffic.
 */
export function computePathUsage(snapshot: Snapshot, vmId: string, vmIo?: VmIo): PathUsage | null {
  const vm = snapshot.devices[vmId];
  if (vm?.kind !== 'vm') return null;
  const hostField = vm.fields.host;
  const host =
    typeof hostField === 'string' && snapshot.devices[hostField]
      ? snapshot.devices[hostField]
      : ancestorOfKind(snapshot.devices, vmId, 'ahv-host');
  const hostId = host?.id;
  const owner = vm.fields.ownerCvm;
  const cvmId =
    typeof owner === 'string'
      ? owner
      : hostId && snapshot.devices[`${hostId}.cvm`]
        ? `${hostId}.cvm`
        : undefined;
  const scope: PathUsage['scope'] =
    vmIo && (vmIo.paths.size > 0 || vmIo.uplinks.size > 0) ? 'vm' : 'host';
  const linkIds = new Set<string>();
  const deviceIds = new Set<string>([vmId]);
  if (cvmId) deviceIds.add(cvmId);
  const uplinks = new Map<string, { deviceId: string; count: number }>();
  const targets = new Map<string, { deviceId: string; count: number }>();
  let traceCount = 0;

  const under = (id: string | undefined, ancestor: string | undefined): boolean =>
    id !== undefined && ancestor !== undefined && isDescendant(snapshot.devices, id, ancestor);
  const hostEnd = (l: LinkView | undefined): string | undefined => {
    if (!l || !hostId) return undefined;
    if (under(l.a.device, hostId)) return l.a.device;
    if (under(l.b.device, hostId)) return l.b.device;
    return undefined;
  };
  const isSwitch = (id: string) => snapshot.devices[id]?.kind === 'switch';
  const touchesUplink = (t: Trace): boolean =>
    t.links.some((id) => {
      const l = snapshot.links[id];
      return !!l && !!vmIo && (vmIo.uplinks.has(l.a.device) || vmIo.uplinks.has(l.b.device));
    });
  const isVmTrace = (t: Trace): boolean => {
    if (!vmIo || !isIoCategory(t.category)) return false;
    if (vmIo.paths.size > 0) {
      return vmIo.paths.has(`${t.src}~${t.dst}`) || vmIo.paths.has(`${t.dst}~${t.src}`);
    }
    const ends = [t.src, t.dst];
    return (
      ends.some((e) => under(e, hostId)) && ends.some((e) => under(e, cvmId)) && touchesUplink(t)
    );
  };

  for (const t of snapshot.traces) {
    if (t.links.length === 0) continue;
    if (scope === 'vm' ? !isVmTrace(t) : !isStorageCategory(t.category)) continue;
    const first = snapshot.links[t.links[0] ?? ''];
    const last = snapshot.links[t.links[t.links.length - 1] ?? ''];
    const fromHost = hostEnd(first);
    const toHost = hostEnd(last);
    if (!fromHost && !toHost) continue;
    // Count requests only (traffic leaving the host), so request/response pairs count once.
    if (!fromHost) continue;
    traceCount += 1;
    for (const id of t.links) {
      linkIds.add(id);
      const l = snapshot.links[id];
      if (l) {
        deviceIds.add(l.a.device);
        deviceIds.add(l.b.device);
      }
    }
    if (first) {
      const u = uplinks.get(first.id) ?? { deviceId: fromHost, count: 0 };
      u.count += 1;
      uplinks.set(first.id, u);
    }
    if (last && t.result === 'delivered' && last.id !== first?.id) {
      const far = isSwitch(last.a.device) ? last.b.device : last.a.device;
      const c = targets.get(last.id) ?? { deviceId: far, count: 0 };
      c.count += 1;
      targets.set(last.id, c);
    }
  }
  // The vswitch(es) whose uplinks carry the traffic.
  const used = new Set([...uplinks.values()].map((u) => u.deviceId));
  for (const d of Object.values(snapshot.devices)) {
    if (!isBondKind(d.kind) || d.parent !== hostId) continue;
    if (bondMembers(d).some((m) => used.has(m))) deviceIds.add(d.id);
  }
  return {
    vmId,
    hostId,
    cvmId,
    scope,
    linkIds,
    deviceIds,
    uplinks: shares(uplinks, snapshot),
    targets: shares(targets, snapshot),
    traceCount,
  };
}

export interface BondMember {
  readonly nicId: string;
  readonly label: string;
  readonly linkId: string | undefined;
  readonly status: LinkView['status'];
  readonly total: number;
  readonly byCategory: Readonly<Record<TrafficCategory, number>>;
  readonly share: number;
}

export interface BondUtilization {
  readonly vswitchId: string;
  readonly label: string;
  readonly bondMode: string;
  readonly members: readonly BondMember[];
}

/** Bond member utilization per virtual switch of a host, from `LinkView.util`. */
export function bondUtilization(snapshot: Snapshot, hostId: string): BondUtilization[] {
  const out: BondUtilization[] = [];
  const links = Object.values(snapshot.links);
  const vswitches = Object.values(snapshot.devices)
    .filter((d) => isBondKind(d.kind) && d.parent === hostId)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const vs of vswitches) {
    const nicIds = bondMembers(vs);
    const raw = nicIds.map((nicId) => {
      const l = links.find((x) => x.a.device === nicId || x.b.device === nicId);
      const byCategory = l?.util ?? {};
      const total = Object.values(byCategory).reduce((s, v) => s + v, 0);
      return { nicId, l, byCategory, total };
    });
    const sum = raw.reduce((s, r) => s + r.total, 0);
    out.push({
      vswitchId: vs.id,
      label: vs.label,
      bondMode: String(vs.fields.bondMode ?? 'unknown'),
      members: raw.map((r) => ({
        nicId: r.nicId,
        label: snapshot.devices[r.nicId]?.label ?? r.nicId,
        linkId: r.l?.id,
        status: r.l?.status ?? 'down',
        total: r.total,
        byCategory: r.byCategory,
        share: sum > 0 ? r.total / sum : 0,
      })),
    });
  }
  return out;
}
