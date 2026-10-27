/**
 * Path-usage view (SPEC §6.4b), first version. Pure functions over a `Snapshot`.
 *
 * A vDisk's IO only ever leaves through its owning Stargate's node (normally the CVM on the VM's
 * host), so a VM's paths are the storage traces that start or end on that host's NICs. The
 * contract does not (yet) tag traces with a source VM/vDisk, so this is per-host for now; see the
 * stream B report for the proposed `Trace.src` / `Trace.flowOwner` additions.
 */
import type { DeviceView, LinkView, Snapshot, TrafficCategory } from '../../engine/types';
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

export function computePathUsage(snapshot: Snapshot, vmId: string): PathUsage | null {
  const vm = snapshot.devices[vmId];
  if (vm?.kind !== 'vm') return null;
  const host = ancestorOfKind(snapshot.devices, vmId, 'ahv-host');
  const hostId = host?.id;
  const owner = vm.fields.ownerCvm;
  const cvmId =
    typeof owner === 'string'
      ? owner
      : hostId && snapshot.devices[`${hostId}.cvm`]
        ? `${hostId}.cvm`
        : undefined;
  const linkIds = new Set<string>();
  const deviceIds = new Set<string>([vmId]);
  if (cvmId) deviceIds.add(cvmId);
  const uplinks = new Map<string, { deviceId: string; count: number }>();
  const targets = new Map<string, { deviceId: string; count: number }>();
  let traceCount = 0;

  const hostEnd = (l: LinkView | undefined): string | undefined => {
    if (!l || !hostId) return undefined;
    if (isDescendant(snapshot.devices, l.a.device, hostId)) return l.a.device;
    if (isDescendant(snapshot.devices, l.b.device, hostId)) return l.b.device;
    return undefined;
  };
  const isSwitch = (id: string) => snapshot.devices[id]?.kind === 'switch';

  for (const t of snapshot.traces) {
    if (!isStorageCategory(t.category) || t.links.length === 0) continue;
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
  for (const d of Object.values(snapshot.devices)) {
    if (d.kind !== 'vswitch' || d.parent !== hostId) continue;
    const members = String(d.fields.uplinks ?? '').split(',');
    if ([...uplinks.values()].some((u) => members.includes(u.deviceId))) deviceIds.add(d.id);
  }
  return {
    vmId,
    hostId,
    cvmId,
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
    .filter((d) => d.kind === 'vswitch' && d.parent === hostId)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const vs of vswitches) {
    const nicIds = String(vs.fields.uplinks ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
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
