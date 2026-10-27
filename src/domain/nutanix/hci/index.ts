/**
 * Stream G: the Nutanix HCI data path (SPEC §6.3, §6.3a, §6.4a T2 rows) for T2 and T3.
 * Disks are devices; each CVM's Stargate uses `backendFor(cvm)` as its `StorageBackend`.
 * Only CVM-bearing nodes (HCI, storage-only) hold data.
 */
import type { DeviceId } from '../../../engine/types';
import type { HciDomain, StorageBackend } from '../../contracts';
import { hciActions } from './actions';
import { HciBackend } from './backend';
import { DiskDevice } from './disk';
import { readLayout } from './layout';
import { HCI_TRAFFIC } from './messages';
import { HciStore } from './store';

export { BLOCK_RULE, HCI_ASSUMPTIONS } from './assumptions';
export { HciBackend } from './backend';
export { DiskDevice, type DiskState } from './disk';
export { readLayout, vdiskId } from './layout';
export { HCI_TRAFFIC, MSG } from './messages';
export { type BlockAwareness, blockAwareness, placeReplicas } from './placement';
export { HciStore, type Resiliency } from './store';

export const createHciDomain: HciDomain = ({ topology, profile }) => {
  const layout = readLayout(topology);
  const store = new HciStore(layout, profile);
  const anchorDisk = layout.nodes.flatMap((n) => n.disks.map((d) => d.id)).sort()[0];
  const disks = new Map<DeviceId, DiskDevice>();
  for (const n of layout.nodes) {
    for (const d of n.disks) disks.set(d.id, new DiskDevice(d, n.cvm, store, d.id === anchorDisk));
  }
  const anchorCvm = layout.nodes[0]?.cvm;
  const backends = new Map<DeviceId, HciBackend>();
  const backendFor = (cvm: DeviceId): StorageBackend => {
    let b = backends.get(cvm);
    if (b === undefined) {
      b = new HciBackend(cvm, store, cvm === anchorCvm);
      backends.set(cvm, b);
    }
    return b;
  };
  return {
    devices: [...disks.values()],
    actions: hciActions(store, disks),
    traffic: HCI_TRAFFIC,
    backendFor,
  };
};
