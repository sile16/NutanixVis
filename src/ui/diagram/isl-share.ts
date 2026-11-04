/**
 * Inter-switch link (ISL) share of storage IO (pure). Over the activity window, the fraction of
 * storage IO messages (NVMe/TCP IO, HCI `io-*`) whose path crossed a switch-to-switch link. With
 * one bonded storage vSwitch the switches learn each storage interface's MAC on one bond member
 * (MAC pinning) or hash each connection onto one (LACP), so a portal on the other switch is
 * reached over the ISL; this makes that visible. Counts messages, not bytes: a sampling view of
 * the model's workload, not a bandwidth measurement.
 */
import type { Snapshot } from '../../engine/types';

export interface IslShare {
  readonly linkId: string;
  /** Storage IO messages that crossed this ISL within the window. */
  readonly count: number;
  /** Storage IO messages on any path within the window. */
  readonly total: number;
  /** count / total, 0..1 (0 when there was no IO). */
  readonly share: number;
}

/** Data IO categories (no keep-alives or health checks). */
export const isStorageIoCategory = (c: string): boolean => c.startsWith('io-') || c === 'nvme-io';

/** Links whose two ends are switches. */
export function islLinks(snapshot: Snapshot): string[] {
  const isSwitch = (id: string) => snapshot.devices[id]?.kind === 'switch';
  return Object.values(snapshot.links)
    .filter((l) => isSwitch(l.a.device) && isSwitch(l.b.device))
    .map((l) => l.id)
    .sort();
}

/** Share of delivered storage IO that crossed each ISL, over the snapshot's traces. */
export function islShares(snapshot: Snapshot): IslShare[] {
  const isls = islLinks(snapshot);
  if (isls.length === 0) return [];
  const counts = new Map(isls.map((id) => [id, 0]));
  let total = 0;
  for (const t of snapshot.traces) {
    if (t.result !== 'delivered' || !isStorageIoCategory(t.category) || t.links.length === 0) {
      continue;
    }
    total += 1;
    for (const id of new Set(t.links)) {
      const n = counts.get(id);
      if (n !== undefined) counts.set(id, n + 1);
    }
  }
  return isls.map((linkId) => {
    const count = counts.get(linkId) ?? 0;
    return { linkId, count, total, share: total > 0 ? count / total : 0 };
  });
}

/** Edge label for an ISL, e.g. `ISL · 25% of storage IO`; null when no IO ran in the window. */
export function islLabel(s: IslShare): string | null {
  if (s.total === 0) return null;
  return `ISL · ${Math.round(s.share * 100)}% of storage IO`;
}
