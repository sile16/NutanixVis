import { describe, expect, it } from 'vitest';
import { citations } from '../../src/domain/citations';
import { profiles } from '../../src/domain/versions';
import { CONFIDENCES, isCited, leaves } from './helpers';

// Every field the Profile type declares, so a new contract field without a value fails here.
const EXPECTED_GROUPS: Record<string, number> = {
  ahvHa: 10,
  redirector: 5,
  cluster: 9,
  hades: 4,
  hci: 15,
  bond: 4,
  externalStorage: 18,
  flasharray: 10,
  guest: 2,
  dnd: 3,
};

describe.each(Object.values(profiles))('profile $id', (profile) => {
  const all = leaves(profile);

  it('has every group and field', () => {
    const counts: Record<string, number> = {};
    for (const l of all) {
      const g = l.path.split('.')[0] ?? '';
      counts[g] = (counts[g] ?? 0) + 1;
    }
    expect(counts).toEqual(EXPECTED_GROUPS);
  });

  it.each(all.map((l) => [l.path, l] as const))('%s is a valid Cited', (_path, leaf) => {
    expect(isCited(leaf.cited)).toBe(true);
    expect(CONFIDENCES).toContain(leaf.cited.confidence);
    if (leaf.cited.confidence !== 'assumption') expect(leaf.cited.cite.length).toBeGreaterThan(0);
    for (const id of leaf.cited.cite) expect(citations[id], `unknown cite id ${id}`).toBeDefined();
    if (leaf.cited.note !== undefined) expect(leaf.cited.note.trim()).not.toBe('');
    // Non-verified values must explain themselves.
    if (leaf.cited.confidence !== 'verified') expect(leaf.cited.note).toBeTruthy();
  });

  it('numeric values are finite and non-negative, except the reconnect-forever sentinel', () => {
    for (const l of all) {
      const v = l.cited.value;
      if (typeof v !== 'number') continue;
      expect(Number.isFinite(v), l.path).toBe(true);
      if (l.path !== 'externalStorage.controllerLossTimeoutS')
        expect(v, l.path).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.ahvHa.fenceAtS)).toBe(true);
  });

  it('AHV HA timeline is ordered', () => {
    const h = profile.ahvHa;
    expect(h.timeoutStartS.value + h.disconnectTimeoutS.value).toBe(h.fenceAtS.value);
    expect(h.fenceAtS.value).toBeLessThan(h.restartByS.value);
  });

  it('NVMe IO timeout covers the lost-path hold (SPEC §6.4c)', () => {
    // Otherwise a command could be aborted and retried elsewhere while still in flight.
    const es = profile.externalStorage;
    const hold =
      es.lostPathHoldKatoMultiplier.value * es.keepAliveTimeoutS.value +
      es.commandQuiesceTimeS.value;
    expect(es.ioTimeoutS.value).toBeGreaterThanOrEqual(hold);
    expect(es.lostPathHoldKatoMultiplier.value).toBeGreaterThanOrEqual(2);
    expect(es.lostPathHoldKatoMultiplier.value).toBeLessThanOrEqual(3);
  });
});
