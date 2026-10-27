/**
 * Snapshot builder (SPEC §5.6): plain, deep-frozen, versioned data. Inputs are copied first so
 * freezing never reaches into a device's live state.
 */
import type { DerivedValue } from './context';
import type {
  DeviceView,
  LinkView,
  SimEvent,
  SimTime,
  Snapshot,
  Trace,
  VersionSelection,
} from './types';

/** Recursively freeze plain objects and arrays in place; returns the same value. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(value);
}

/** Copy a device view so the snapshot owns its arrays and records. */
export function copyView(v: DeviceView): DeviceView {
  return { ...v, badges: [...v.badges], fields: { ...v.fields } };
}

export interface SnapshotParts {
  readonly version: number;
  readonly simTime: SimTime;
  readonly seed: number;
  readonly topologyId: string;
  readonly versions: VersionSelection;
  readonly devices: readonly DeviceView[];
  readonly links: readonly LinkView[];
  readonly traces: readonly Trace[];
  readonly events: readonly SimEvent[];
  readonly derived: Readonly<Record<string, DerivedValue>>;
  readonly nextTimerAt: SimTime | null;
}

export function buildSnapshot(p: SnapshotParts): Snapshot {
  const devices: Record<string, DeviceView> = {};
  for (const d of [...p.devices].sort((a, b) => cmp(a.id, b.id))) devices[d.id] = copyView(d);
  const links: Record<string, LinkView> = {};
  for (const l of [...p.links].sort((a, b) => cmp(a.id, b.id))) {
    links[l.id] = { ...l, a: { ...l.a }, b: { ...l.b }, util: { ...l.util } };
  }
  const derived: Record<string, DerivedValue> = {};
  for (const [k, v] of Object.entries(p.derived)) {
    derived[k] = v !== null && typeof v === 'object' ? { ...v } : v;
  }
  return deepFreeze({
    version: p.version,
    simTime: p.simTime,
    seed: p.seed,
    topologyId: p.topologyId,
    versions: { ...p.versions },
    devices,
    links,
    traces: p.traces.map((t) => ({ ...t, links: [...t.links] })),
    events: [...p.events],
    derived,
    nextTimerAt: p.nextTimerAt,
  });
}

/** Same content, new version (e.g. after an action is queued). */
export function bumpVersion(
  s: Snapshot,
  version: number,
  derived: Readonly<Record<string, DerivedValue>>,
): Snapshot {
  return deepFreeze({ ...s, version, derived: { ...s.derived, ...derived } });
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
