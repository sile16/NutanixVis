/**
 * The guided scenarios (the UI's Scenario tab): ten failures picked for what they show a storage
 * engineer, each written once per storage-network configuration it applies to. The menu lists
 * the ones for the topology that is loaded.
 */
import { T1_CONFIGS, type T1Config } from '../../topologies/t1-configs';
import type { ScenarioDef } from '../define';
import f01 from './01-array-port';
import f02 from './02-controller';
import f03 from './03-storage-nic';
import f04 from './04-isl-traffic';
import f05 from './05-isl-loss';
import f06 from './06-host-reboot';
import f07 from './07-stargate';
import f08 from './08-cvm';
import f09 from './09-switch';
import f10 from './10-nic-hang';
import type { GuidedFamily } from './kit';

export const guidedFamilies: readonly GuidedFamily[] = [
  f01,
  f02,
  f03,
  f04,
  f05,
  f06,
  f07,
  f08,
  f09,
  f10,
];

export interface GuidedScenario {
  readonly family: GuidedFamily;
  readonly config: T1Config;
  readonly def: ScenarioDef;
}

export const guided: readonly GuidedScenario[] = guidedFamilies.flatMap((family) =>
  T1_CONFIGS.filter((c) => family.configs.includes(c.key)).map((config) => ({
    family,
    config,
    def: family.build(config),
  })),
);

export const guidedScenarios: readonly ScenarioDef[] = guided.map((g) => g.def);

/** The guided scenarios for a topology menu entry, in menu order. */
export const guidedFor = (catalogId: string): readonly GuidedScenario[] =>
  guided.filter((g) => g.config.catalogId === catalogId);

export const guidedById = (id: string): GuidedScenario | undefined =>
  guided.find((g) => g.def.id === id);
