import type { Cited, Confidence } from '../../src/engine/types';

export const CONFIDENCES: readonly Confidence[] = [
  'verified',
  'inferred',
  'unverified',
  'assumption',
  'lab-observed',
];

export interface Leaf {
  readonly path: string;
  readonly cited: Cited<unknown>;
}

export function isCited(x: unknown): x is Cited<unknown> {
  return (
    typeof x === 'object' &&
    x !== null &&
    'value' in x &&
    'cite' in x &&
    'confidence' in x &&
    Array.isArray((x as { cite: unknown }).cite)
  );
}

/** Every `Cited` leaf of a profile (skips the top-level `id`/`label` strings). */
export function leaves(profile: object): Leaf[] {
  const out: Leaf[] = [];
  for (const [group, fields] of Object.entries(profile)) {
    if (typeof fields !== 'object' || fields === null) continue;
    for (const [name, v] of Object.entries(fields)) {
      out.push({ path: `${group}.${name}`, cited: v as Cited<unknown> });
    }
  }
  return out;
}

export function formatValue(v: unknown): string {
  if (typeof v === 'string') return `'${v}'`;
  if (typeof v === 'object' && v !== null) {
    return `{ ${Object.entries(v)
      .map(([k, x]) => `${k}: ${formatValue(x)}`)
      .join(', ')} }`;
  }
  return String(v);
}
