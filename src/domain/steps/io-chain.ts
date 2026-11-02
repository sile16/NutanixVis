/**
 * The IO path of one VM as an ordered chain of hops the UI can draw, read from a snapshot:
 * VM → AHV iSCSI redirector (Frodo) → serving CVM → Stargate (SPDK NVMe/TCP initiator,
 * queue-depth selection among optimized paths) → the CVM's storage NIC(s) → array port(s).
 *
 * It is also published by each VM as the `ioChain` view field (JSON), so the UI needs only the
 * snapshot. HCI VMs end at Stargate (there is no external array leg).
 */
import type { DeviceView, ViewField } from '../../engine/types';

export type IoHopRole = 'vm' | 'redirector' | 'cvm' | 'stargate' | 'nic' | 'array-port';

export interface IoHop {
  readonly role: IoHopRole;
  /** Device or interface ids on this hop (several NICs / ports when IO is spread). */
  readonly ids: readonly string[];
  /** Short label for the hop, public-safe. */
  readonly label: string;
  /** Redirector hop only: host NICs the iSCSI leg crosses to reach a remote CVM. */
  readonly via?: readonly string[];
}

export interface IoChain {
  readonly vm: string;
  /** The VM's IO is stuck right now (stalled, or commands waiting). */
  readonly stalled: boolean;
  /** The serving CVM is not the one on the VM's own host (after a redirect, or compute-only). */
  readonly remote: boolean;
  /** Path selection among optimized paths at Stargate, when it is an external-array leg. */
  readonly selector: string | null;
  readonly hops: readonly IoHop[];
}

export interface IoChainInput {
  readonly vm: string;
  readonly host: string | null;
  readonly cvm: string | null;
  readonly stalled: boolean;
  /** NICs the CVM's array IO egressed on during the last tick. */
  readonly storageNics: readonly string[];
  /** Array interfaces the IO reached (from the NVMe path ids). */
  readonly arrayPorts: readonly string[];
  /** Host links the VM's iSCSI leg crossed, other than the storage NICs (redirected IO). */
  readonly hostNics: readonly string[];
  readonly selector: string | null;
  /** The serving CVM sits on the VM's own host. */
  readonly local: boolean;
}

export function buildIoChain(i: IoChainInput): IoChain {
  const hops: IoHop[] = [{ role: 'vm', ids: [i.vm], label: 'VM' }];
  if (i.host !== null) {
    hops.push({
      role: 'redirector',
      ids: [i.host],
      label: 'AHV iSCSI redirector (Frodo)',
      ...(i.hostNics.length > 0 ? { via: i.hostNics } : {}),
    });
  }
  if (i.cvm !== null) {
    hops.push({ role: 'cvm', ids: [i.cvm], label: 'CVM' });
    hops.push({
      role: 'stargate',
      ids: [i.cvm],
      label: i.selector === null ? 'Stargate' : 'Stargate (SPDK NVMe/TCP initiator)',
    });
  }
  if (i.storageNics.length > 0)
    hops.push({ role: 'nic', ids: i.storageNics, label: 'Storage NIC' });
  if (i.arrayPorts.length > 0) {
    hops.push({ role: 'array-port', ids: i.arrayPorts, label: 'Array port' });
  }
  return { vm: i.vm, stalled: i.stalled, remote: !i.local, selector: i.selector, hops };
}

/** Parse the `ioChain` view field of a VM; null when absent (an older fixture). */
export function ioChainOf(view: DeviceView | undefined): IoChain | null {
  const raw: ViewField | undefined = view?.fields.ioChain;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as IoChain;
  } catch {
    return null;
  }
}
