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
