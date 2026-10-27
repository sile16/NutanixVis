/**
 * Replica placement and the block-awareness rule (Bible 4i "Data Resilience", "Block Fault
 * Tolerant Data Placement"). Pure functions: deterministic for the same inputs.
 */
import type { DeviceId } from '../../../engine/types';
import { BLOCK_RULE } from './assumptions';

export type BlockAwareness = 'met' | 'not-met' | 'off';

/**
 * Bible 4i: block awareness needs ≥3 blocks (≥5 for FT2) and, with X = nodes in the largest
 * block, the remaining blocks must hold ≥2X nodes (FT1) / ≥4X (FT2). `off` when any data node
 * has no block assignment (e.g. T3 hosts).
 */
export function blockAwareness(
  blocks: readonly (string | undefined)[],
  ft: number,
): BlockAwareness {
  if (blocks.length === 0 || blocks.some((b) => b === undefined)) return 'off';
  const counts = new Map<string, number>();
  for (const b of blocks) if (b !== undefined) counts.set(b, (counts.get(b) ?? 0) + 1);
  const key = ft >= 2 ? 'ft2' : 'ft1';
  if (counts.size < BLOCK_RULE.minBlocks.value[key]) return 'not-met';
  const largest = Math.max(...counts.values());
  const rest = blocks.length - largest;
  return rest >= BLOCK_RULE.remainderFactor.value[key] * largest ? 'met' : 'not-met';
}

export interface PlacementRequest {
  /** Rotation key (extent-group ordinal) so replicas spread evenly over nodes. */
  readonly key: number;
  /** Preferred first replica: the writing Stargate's node (data locality, Bible 4g). */
  readonly first?: DeviceId;
  readonly count: number;
  /** Nodes able to take a replica now, in sorted order. */
  readonly candidates: readonly DeviceId[];
  /** Nodes that already hold (or must not get) a replica of this extent group. */
  readonly exclude: ReadonlySet<DeviceId>;
  /** Blocks already holding a live replica of this extent group. */
  readonly usedBlocks?: ReadonlySet<string>;
  readonly blockOf: (node: DeviceId) => string | undefined;
  /** True when block awareness is `met`: prefer a block not used yet. */
  readonly blockAware: boolean;
}

/**
 * Up to `count` distinct nodes. With block awareness met, each pick prefers a block that holds no
 * replica yet; when none is left (e.g. rebuilding after a whole block failed) it falls back to
 * node-only placement so RF is still restored (`inferred` from "best-effort" in Bible 4i).
 * Without block awareness, placement is node-aware only, so replicas may share a block.
 */
export function placeReplicas(req: PlacementRequest): DeviceId[] {
  const out: DeviceId[] = [];
  const blocks = new Set(req.usedBlocks ?? []);
  const take = (n: DeviceId) => {
    out.push(n);
    const b = req.blockOf(n);
    if (b !== undefined) blocks.add(b);
  };
  if (
    req.first !== undefined &&
    req.count > 0 &&
    req.candidates.includes(req.first) &&
    !req.exclude.has(req.first)
  ) {
    take(req.first);
  }
  while (out.length < req.count) {
    const pool = req.candidates.filter((n) => !req.exclude.has(n) && !out.includes(n));
    if (pool.length === 0) break;
    const start = ((req.key % pool.length) + pool.length) % pool.length;
    const rotated = [...pool.slice(start), ...pool.slice(0, start)];
    const fresh = req.blockAware
      ? rotated.find((n) => {
          const b = req.blockOf(n);
          return b === undefined || !blocks.has(b);
        })
      : undefined;
    const pick = fresh ?? rotated[0];
    if (pick === undefined) break;
    take(pick);
  }
  return out;
}
