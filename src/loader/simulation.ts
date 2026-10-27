/**
 * Build a runnable `Simulation` from a topology id + options + version selection (SPEC §13.2
 * stream I). Domain modules plug in by passing `devices`/`actions`; until they land, every
 * non-network topology device is a `StaticDevice` so the UI can render and fail/recover it.
 */

import { type ResolvedVersions, resolveVersions } from '../domain/versions';
import type { Profile } from '../domain/versions/profile';
import type { ActionDefinition } from '../engine/actions';
import { createSimulation, type EngineSimulation } from '../engine/sim';
import type { Device, DeviceView, ViewField } from '../engine/types';
import { buildTopology, type OptionValues, type TopologyId } from '../topologies';
import type { DeviceSpec, Topology } from '../topologies/schema';
import { topologyToNetwork } from './network';

/** Device kinds the engine's network runtime already represents (and views) itself. */
const NETWORK_KINDS: ReadonlySet<DeviceSpec['kind']> = new Set(['nic', 'switch', 'vswitch']);

/** Placeholder for a topology device with no domain model yet: static view, fail/recover only. */
export class StaticDevice implements Device<Profile> {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly parentId?: string;
  private readonly fields: Readonly<Record<string, ViewField>>;

  constructor(spec: DeviceSpec) {
    this.id = spec.id;
    this.kind = spec.kind;
    this.label = spec.label;
    if (spec.parent) this.parentId = spec.parent;
    const fields: Record<string, ViewField> = {};
    for (const [k, v] of Object.entries(spec)) {
      if (k === 'id' || k === 'kind' || k === 'label' || k === 'parent') continue;
      fields[k] = Array.isArray(v) ? v.join(',') : (v as ViewField);
    }
    this.fields = fields;
  }

  view(): DeviceView {
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      ...(this.parentId ? { parent: this.parentId } : {}),
      status: 'healthy',
      badges: [],
      fields: this.fields,
    };
  }
}

export interface LoadOptions {
  readonly topologyId: TopologyId;
  readonly options?: OptionValues;
  readonly versions?: { readonly nutanix?: string; readonly flasharray?: string };
  readonly seed?: number;
  /**
   * Domain device factory. Return devices for the ids it models; any topology device it doesn't
   * cover (and isn't a network element) becomes a `StaticDevice`.
   */
  readonly domain?: (ctx: { readonly topology: Topology; readonly versions: ResolvedVersions }) => {
    readonly devices: readonly Device<Profile>[];
    readonly actions?: readonly ActionDefinition[];
  };
}

export interface LoadedSimulation {
  readonly sim: EngineSimulation;
  readonly topology: Topology;
  readonly versions: ResolvedVersions;
}

export function loadSimulation(opts: LoadOptions): LoadedSimulation {
  const topology = buildTopology(opts.topologyId, opts.options ?? {});
  const hasArray = topology.devices.some((d) => d.kind === 'fa-array');
  const versions = resolveVersions(opts.versions ?? {}, { hasArray });
  const { profile } = versions;

  const domain = opts.domain?.({ topology, versions }) ?? { devices: [] };
  const modeled = new Set(domain.devices.map((d) => d.id));
  const placeholders = topology.devices
    .filter((d) => !NETWORK_KINDS.has(d.kind) && !modeled.has(d.id))
    .map((d) => new StaticDevice(d));

  const sim = createSimulation<Profile>({
    devices: [...domain.devices, ...placeholders],
    network: topologyToNetwork(topology, {
      lacpFastDetectS: profile.bond.lacpFastDetectS.value,
      lacpSlowDetectS: profile.bond.lacpSlowDetectS.value,
      slbRebalanceIntervalS: profile.bond.slbRebalanceIntervalS.value,
    }),
    profile,
    seed: opts.seed ?? 1,
    topologyId: topology.id,
    versions: versions.selection,
    ...(domain.actions ? { actions: domain.actions } : {}),
  });
  return { sim, topology, versions };
}
