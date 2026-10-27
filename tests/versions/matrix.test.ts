import { describe, expect, it } from 'vitest';
import { getProfile, matrix, profiles, resolveVersions } from '../../src/domain/versions';

function versionKey(v: string): number[] {
  return (v.match(/\d+/g) ?? []).map(Number);
}

/** Positive when a > b. */
function compare(a: string, b: string): number {
  const x = versionKey(a);
  const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

describe('version matrix', () => {
  it('is non-empty and newest-first', () => {
    expect(matrix.length).toBeGreaterThan(0);
    for (let i = 1; i < matrix.length; i++) {
      const prev = matrix[i - 1];
      const cur = matrix[i];
      if (!prev || !cur) throw new Error('unreachable');
      expect(compare(prev.aos, cur.aos)).toBeGreaterThan(0);
    }
  });

  it.each(matrix.map((r) => [r.id, r] as const))('%s is well-formed', (_id, r) => {
    expect(r.id).toBe(`aos-${r.aos}`);
    expect(r.cite.length).toBeGreaterThan(0);
    expect(() => getProfile(r.profileId)).not.toThrow();
    expect(r.flasharray.length).toBeGreaterThan(0);
    const ids = r.flasharray.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of r.flasharray) {
      expect(f.id).toMatch(/^purity-\d+\.\d+$/);
      if (f.profileId !== undefined) expect(profiles[f.profileId]).toBeDefined();
    }
    for (let i = 1; i < r.flasharray.length; i++) {
      const prev = r.flasharray[i - 1];
      const cur = r.flasharray[i];
      if (!prev || !cur) throw new Error('unreachable');
      expect(compare(prev.id, cur.id)).toBeGreaterThan(0);
    }
  });

  it('current release is AOS 7.6 with Purity//FA 6.12 and 6.11', () => {
    const r = matrix[0];
    expect(r?.id).toBe('aos-7.6');
    expect(r?.profileId).toBe('current');
    expect(r?.flasharray.map((f) => f.id)).toEqual(['purity-6.12', 'purity-6.11']);
  });
});

describe('resolveVersions', () => {
  it('defaults to the newest releases', () => {
    const v = resolveVersions();
    expect(v.nutanix.id).toBe('aos-7.6');
    expect(v.flasharray?.id).toBe('purity-6.12');
    expect(v.profile.id).toBe('current');
    expect(v.selection).toEqual({
      nutanix: 'aos-7.6',
      flasharray: 'purity-6.12',
      profileId: 'current',
    });
  });

  it('honors a supported FlashArray selection', () => {
    const v = resolveVersions({ nutanix: 'aos-7.6', flasharray: 'purity-6.11' });
    expect(v.flasharray?.id).toBe('purity-6.11');
    expect(v.selection.flasharray).toBe('purity-6.11');
  });

  it('falls back to the newest supported FlashArray release', () => {
    const v = resolveVersions({ flasharray: 'purity-6.4' });
    expect(v.flasharray?.id).toBe('purity-6.12');
  });

  it('falls back to the newest Nutanix release for an unknown id', () => {
    expect(resolveVersions({ nutanix: 'aos-1.0' }).nutanix.id).toBe('aos-7.6');
  });

  it('omits FlashArray when the topology has no array', () => {
    const v = resolveVersions({ flasharray: 'purity-6.11' }, { hasArray: false });
    expect(v.flasharray).toBeUndefined();
    expect('flasharray' in v.selection).toBe(false);
    expect(v.selection).toEqual({ nutanix: 'aos-7.6', profileId: 'current' });
  });

  it('returns frozen data', () => {
    const v = resolveVersions();
    expect(Object.isFrozen(v.nutanix)).toBe(true);
    expect(Object.isFrozen(v.profile.externalStorage)).toBe(true);
  });
});
