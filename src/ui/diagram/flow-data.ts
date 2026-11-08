/**
 * Throughput-model data in a snapshot (pure): the `flows` device's per-direction link loads
 * (docs/research/link-congestion.md). Shared by the link labels and the bond utilization view.
 */
import type { Snapshot } from '../../engine/types';

export const FLOWS_DEVICE = 'flows';

export interface DirUsage {
  readonly from: string;
  readonly to: string;
  readonly gbps: number;
  readonly capacityGbps: number;
  readonly delayUs: number;
  readonly dropGbps: number;
}

/** Per-link direction loads, or null when the topology has no throughput model. */
export function linkUsage(
  snapshot: Pick<Snapshot, 'devices'>,
): ReadonlyMap<string, readonly DirUsage[]> | null {
  const raw = snapshot.devices[FLOWS_DEVICE]?.fields.links;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, DirUsage[]>;
    return new Map(Object.entries(parsed));
  } catch {
    return null;
  }
}

/** A NIC's received and sent Gb/s on its cable, and the cable's line rate. */
export function nicLoad(
  dirs: readonly DirUsage[] | undefined,
  nic: string,
): { readonly inGbps: number; readonly outGbps: number; readonly capacityGbps: number } | null {
  if (!dirs || dirs.length === 0) return null;
  const into = dirs.find((d) => d.to === nic);
  const out = dirs.find((d) => d.from === nic);
  return {
    inGbps: into?.gbps ?? 0,
    outGbps: out?.gbps ?? 0,
    capacityGbps: into?.capacityGbps ?? out?.capacityGbps ?? 0,
  };
}

/**
 * `linkUsage` with each ISL port-channel's members merged onto its first member (Gb/s, line rate
 * and drops summed per direction, the worst member's queueing delay), the others removed: what the
 * ISL label and its bars show.
 */
export function portChannelUsage(
  snapshot: Pick<Snapshot, 'devices' | 'links'>,
  groups: readonly { readonly id: string; readonly members: readonly string[] }[],
): ReadonlyMap<string, readonly DirUsage[]> | null {
  const usage = linkUsage(snapshot);
  if (!usage) return null;
  const out = new Map(usage);
  for (const g of groups) {
    if (g.members.length < 2) continue;
    const by = new Map<string, DirUsage>();
    for (const m of g.members) {
      for (const d of usage.get(m) ?? []) {
        const k = `${d.from}>${d.to}`;
        const cur = by.get(k);
        by.set(
          k,
          cur
            ? {
                ...cur,
                gbps: cur.gbps + d.gbps,
                capacityGbps: cur.capacityGbps + d.capacityGbps,
                dropGbps: cur.dropGbps + d.dropGbps,
                delayUs: Math.max(cur.delayUs, d.delayUs),
              }
            : d,
        );
      }
      out.delete(m);
    }
    if (by.size > 0) out.set(g.id, [...by.values()]);
  }
  return out;
}
