/**
 * Topology registry. `topologies` holds each family's default instance; `builders` rebuild any
 * variant from schema option values (option-id keyed), which is what the UI and the engine's
 * runtime option actions use. Typed builders are exported for scenarios and tests.
 */
import { diffTopologies, type TopologyDiff } from './diff';
import {
  type Choice,
  defaultValues,
  type OptionDefs,
  type OptionValues,
  paramsFromValues,
} from './options';
import type { Topology } from './schema';
import { buildT1, T1_ID, t1Options } from './t1-ahv-flasharray';
import { buildT1Lab, T1_LAB_ID, t1LabOptions } from './t1-lab';
import { buildT2, T2_ID, t2Options } from './t2-hci-ahv';
import {
  buildT3CoHci,
  buildT3CoSo,
  T3_CO_HCI_ID,
  T3_CO_SO_ID,
  t3CoHciOptions,
  t3CoSoOptions,
} from './t3';

export type { TopologyDiff } from './diff';
export { diffTopologies } from './diff';
export { computeLayout, GRID, layoutJson } from './layout';
export type { Choice, OptionValues } from './options';
export type { T1Params } from './t1-ahv-flasharray';
export type { T1LabParams } from './t1-lab';
export type { T2Params } from './t2-hci-ahv';
export type { T3CoHciParams, T3CoSoParams } from './t3';
export {
  buildT1,
  buildT1Lab,
  buildT2,
  buildT3CoHci,
  buildT3CoSo,
  t1LabOptions,
  t1Options,
  t2Options,
  t3CoHciOptions,
  t3CoSoOptions,
};

export const topologyIds = [T1_ID, T1_LAB_ID, T2_ID, T3_CO_SO_ID, T3_CO_HCI_ID] as const;
export type TopologyId = (typeof topologyIds)[number];

interface Entry {
  readonly options: OptionDefs;
  readonly build: (values: OptionValues) => Topology;
}

const entries: Record<TopologyId, Entry> = {
  [T1_ID]: { options: t1Options, build: (v) => buildT1(paramsFromValues(t1Options, v)) },
  [T1_LAB_ID]: {
    options: t1LabOptions,
    build: (v) => buildT1Lab(paramsFromValues(t1LabOptions, v)),
  },
  [T2_ID]: { options: t2Options, build: (v) => buildT2(paramsFromValues(t2Options, v)) },
  [T3_CO_SO_ID]: {
    options: t3CoSoOptions,
    build: (v) => buildT3CoSo(paramsFromValues(t3CoSoOptions, v)),
  },
  [T3_CO_HCI_ID]: {
    options: t3CoHciOptions,
    build: (v) => buildT3CoHci(paramsFromValues(t3CoHciOptions, v)),
  },
};

export const isTopologyId = (id: string): id is TopologyId =>
  (topologyIds as readonly string[]).includes(id);

/** Build a topology variant from option values keyed by schema option id. */
export function buildTopology(id: TopologyId, values: OptionValues = {}): Topology {
  return entries[id].build(values);
}

/** Generic builders keyed by topology id. */
export const builders: Readonly<Record<TopologyId, (values?: OptionValues) => Topology>> = {
  [T1_ID]: (v = {}) => buildTopology(T1_ID, v),
  [T1_LAB_ID]: (v = {}) => buildTopology(T1_LAB_ID, v),
  [T2_ID]: (v = {}) => buildTopology(T2_ID, v),
  [T3_CO_SO_ID]: (v = {}) => buildTopology(T3_CO_SO_ID, v),
  [T3_CO_HCI_ID]: (v = {}) => buildTopology(T3_CO_HCI_ID, v),
};

/** Default instance of each topology. */
export const topologies: Readonly<Record<TopologyId, Topology>> = {
  [T1_ID]: buildT1(),
  [T1_LAB_ID]: buildT1Lab(),
  [T2_ID]: buildT2(),
  [T3_CO_SO_ID]: buildT3CoSo(),
  [T3_CO_HCI_ID]: buildT3CoHci(),
};

/** Current option values of a built topology (option `default` = the value it was built with). */
export function optionValuesOf(t: Topology): OptionValues {
  return Object.fromEntries(t.options.map((o) => [o.id, o.value ?? o.default]));
}

/** Declared default option values for a topology id. */
export const defaultOptionValues = (id: TopologyId): OptionValues =>
  defaultValues(entries[id].options);

/**
 * Field-level patch for changing one option on a running topology (SPEC §5.5): rebuild with
 * the new value and diff. For `runtime: true` options the diff only has `changed` entries.
 */
export function optionPatch(
  id: TopologyId,
  current: Topology,
  optionId: string,
  value: Choice,
): { next: Topology; diff: TopologyDiff } {
  const next = buildTopology(id, { ...optionValuesOf(current), [optionId]: value });
  return { next, diff: diffTopologies(current, next) };
}
