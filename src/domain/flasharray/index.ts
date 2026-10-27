/**
 * Stream E: Everpure FlashArray + NVMe/TCP initiator (SPEC §6.4–6.4c). `createExternalStorageDomain`
 * returns the array devices, their actions, the NVMe traffic categories and one
 * `ExternalStorageBackend` per CVM (`backendFor`), which stream F's CVM hosts as a component.
 */
import type { ActionDefinition } from '../../engine/actions';
import type { EngineDevice } from '../../engine/context';
import type { DeviceId } from '../../engine/types';
import type { DomainInput, ExternalStorageDomain } from '../contracts';
import { CauseIndex } from '../nvme-tcp/causes';
import { NVME_TRAFFIC } from '../nvme-tcp/protocol';
import type { Profile } from '../versions/profile';
import { faActions } from './actions';
import { ExternalStorageBackend } from './backend';
import { faDevices } from './devices';
import { type FaFacts, readFacts } from './facts';
import { FlashArrayModel } from './model';

export { ExternalStorageBackend, FaMgmtClient } from './backend';
export { FaArrayDevice, FaControllerDevice, FaInterfaceDevice } from './devices';
export { type FaFacts, readFacts } from './facts';
export { type FaRole, type FaState, FlashArrayModel } from './model';

export interface ExternalStoragePart extends ReturnType<ExternalStorageDomain> {
  readonly devices: readonly EngineDevice<Profile>[];
  readonly actions: readonly ActionDefinition[];
  readonly model: FlashArrayModel;
  readonly facts: FaFacts;
  backendFor(cvm: DeviceId): ExternalStorageBackend;
}

/** Build the external-storage domain with its model exposed (tests, inspector). */
export function buildExternalStorage(input: DomainInput): ExternalStoragePart {
  const facts = readFacts(input.topology, input.profile);
  const model = new FlashArrayModel(facts, input.profile);
  const causes = new CauseIndex();
  const backends = new Map<DeviceId, ExternalStorageBackend>();
  return {
    devices: faDevices(facts, model, causes),
    actions: faActions(model),
    traffic: NVME_TRAFFIC,
    model,
    facts,
    backendFor(cvm) {
      let b = backends.get(cvm);
      if (!b) {
        b = new ExternalStorageBackend(cvm, model, facts, input.profile, causes);
        backends.set(cvm, b);
      }
      return b;
    },
  };
}

export const createExternalStorageDomain: ExternalStorageDomain = buildExternalStorage;
