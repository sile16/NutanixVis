import { describe, expect, it } from 'vitest';
import {
  categoryOrder,
  isCategoryVisible,
  isShowAll,
  parseTrafficFilter,
  presetFilter,
  SHOW_ALL,
  TRAFFIC,
  toggleCategory,
  trafficStyle,
} from './traffic';

describe('traffic styles', () => {
  it('describes every known category (legend tooltips)', () => {
    for (const [cat, s] of Object.entries(TRAFFIC)) expect(s.description, cat).toBeTruthy();
    expect(trafficStyle('iscsi-nop').description).toMatch(/redirector.*Stargate.*Autopath/);
    expect(trafficStyle('rebuild').label).toBe('Rebuild');
  });

  it('orders known categories first, then the rest alphabetically', () => {
    expect(['zz', 'zk', 'io-read', 'aa'].sort(categoryOrder)).toEqual([
      'io-read',
      'zk',
      'aa',
      'zz',
    ]);
  });
});

describe('traffic filter', () => {
  it('shows everything by default', () => {
    expect(isCategoryVisible(SHOW_ALL, 'zk')).toBe(true);
    expect(isCategoryVisible(SHOW_ALL, 'never-seen')).toBe(true);
    expect(isShowAll(SHOW_ALL)).toBe(true);
  });

  it('toggles a single category on top of the preset', () => {
    const f = toggleCategory(SHOW_ALL, 'iscsi-nop');
    expect(isCategoryVisible(f, 'iscsi-nop')).toBe(false);
    expect(isCategoryVisible(f, 'io-read')).toBe(true);
    expect(isShowAll(f)).toBe(false);
    expect(isCategoryVisible(toggleCategory(f, 'iscsi-nop'), 'iscsi-nop')).toBe(true);
  });

  it('"Storage IO only" keeps data IO and hides health checks and control traffic', () => {
    const f = presetFilter('storage');
    for (const c of ['io-read', 'io-write', 'nvme-io', 'replication', 'rebuild'])
      expect(isCategoryVisible(f, c), c).toBe(true);
    for (const c of ['iscsi-nop', 'nvme-keepalive', 'zk', 'ha-poll', 'mgmt', 'new-kind'])
      expect(isCategoryVisible(f, c), c).toBe(false);
  });

  it('"None" also hides categories that appear later', () => {
    expect(isCategoryVisible(presetFilter('none'), 'brand-new')).toBe(false);
  });

  it('round-trips through storage and rejects junk', () => {
    const f = toggleCategory(presetFilter('storage'), 'zk');
    expect(parseTrafficFilter(JSON.stringify(f))).toEqual(f);
    expect(parseTrafficFilter('not json')).toEqual(SHOW_ALL);
    expect(parseTrafficFilter('{"preset":"bogus"}')).toEqual(SHOW_ALL);
    expect(parseTrafficFilter(null)).toEqual(SHOW_ALL);
  });
});
