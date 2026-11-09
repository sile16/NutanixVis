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

export interface IslGroup {
  /**
   * The link the group's label, bars and hover text sit on: its first member that is up (the
   * first member when every one is down), so the label stays while any member carries traffic.
   */
  readonly id: string;
  /** Every member link (parallel switch-to-switch links between the same two switches). */
  readonly members: readonly string[];
}

/**
 * ISL port-channels: parallel links between the same two switches form one group (a real ISL /
 * peer-link has at least two members, and the engine hashes flows across them).
 */
export function islGroups(snapshot: Pick<Snapshot, 'devices' | 'links'>): IslGroup[] {
  const isSwitch = (id: string) => snapshot.devices[id]?.kind === 'switch';
  const by = new Map<string, string[]>();
  for (const l of Object.values(snapshot.links)) {
    if (!isSwitch(l.a.device) || !isSwitch(l.b.device)) continue;
    const key = [l.a.device, l.b.device].sort().join('|');
    by.set(key, [...(by.get(key) ?? []), l.id]);
  }
  return [...by.values()]
    .map((m) => {
      const members = [...m].sort();
      const live = members.find((id) => snapshot.links[id]?.status !== 'down');
      return { id: live ?? (members[0] as string), members };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** One link id per ISL port-channel (its first live member, where the label sits). */
export function islLinks(snapshot: Pick<Snapshot, 'devices' | 'links'>): string[] {
  return islGroups(snapshot).map((g) => g.id);
}

/** Share of delivered storage IO that crossed each ISL port-channel, over the snapshot's traces. */
export function islShares(snapshot: Snapshot): IslShare[] {
  const groups = islGroups(snapshot);
  if (groups.length === 0) return [];
  const isls = groups.map((g) => g.id);
  const groupOf = new Map(groups.flatMap((g) => g.members.map((m) => [m, g.id] as const)));
  const counts = new Map(isls.map((id) => [id, 0]));
  let total = 0;
  for (const t of snapshot.traces) {
    if (t.result !== 'delivered' || !isStorageIoCategory(t.category) || t.links.length === 0) {
      continue;
    }
    total += 1;
    for (const id of new Set(t.links.map((l) => groupOf.get(l)).filter((g) => g !== undefined))) {
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
