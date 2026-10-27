/**
 * Default domain composition (SPEC §13.2 stream I): Nutanix services (F) on top of one storage
 * backend per CVM — the NVMe/TCP initiator + FlashArray (E) when the topology has an array,
 * otherwise the HCI extent store (G). Contract: `src/domain/contracts.ts`.
 */

import type { DomainPart } from '../domain/contracts';
import { createExternalStorageDomain } from '../domain/flasharray';
import { createNutanixDomain } from '../domain/nutanix';
import { createHciDomain } from '../domain/nutanix/hci';
import type { ResolvedVersions } from '../domain/versions';
import type { Topology } from '../topologies/schema';

export function defaultDomain(ctx: {
  readonly topology: Topology;
  readonly versions: ResolvedVersions;
}): Required<DomainPart> {
  const { topology } = ctx;
  const profile = ctx.versions.profile;
  const hasArray = topology.devices.some((d) => d.kind === 'fa-array');
  const storage = hasArray
    ? createExternalStorageDomain({ topology, profile })
    : createHciDomain({ topology, profile });
  // F wires each CVM to `backendFor(cvm)` and calls `attach(cluster)` once all devices exist.
  const nutanix = createNutanixDomain({ topology, profile, backendFor: storage.backendFor });
  return {
    devices: [...storage.devices, ...nutanix.devices],
    actions: [...(storage.actions ?? []), ...(nutanix.actions ?? [])],
    traffic: { ...(storage.traffic ?? {}), ...(nutanix.traffic ?? {}) },
  };
}
