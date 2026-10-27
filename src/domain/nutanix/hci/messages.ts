/** Inter-CVM message kinds of the HCI data path and their traffic categories (SPEC §5.4). */
import type { DeviceId } from '../../../engine/types';

export const MSG = {
  /** Oplog write replicated synchronously to a remote CVM (Bible 4g). */
  replicate: 'hci-replication',
  replicateAck: 'hci-replication-ack',
  /** Read served by a remote replica when there is no local one. */
  read: 'hci-read',
  readResp: 'hci-read-resp',
  /** Curator re-replication of an extent group (Bible 4i). */
  rebuild: 'hci-rebuild',
  rebuildAck: 'hci-rebuild-ack',
} as const;

export const HCI_TRAFFIC: Readonly<Record<string, string>> = {
  [MSG.replicate]: 'replication',
  [MSG.replicateAck]: 'replication',
  [MSG.read]: 'io-read',
  [MSG.readResp]: 'io-read',
  [MSG.rebuild]: 'rebuild',
  [MSG.rebuildAck]: 'rebuild',
};

export interface ReplicatePayload {
  readonly io: string;
  readonly eg: string;
  readonly disk: DeviceId;
  readonly from: DeviceId;
}

export interface AckPayload {
  readonly io: string;
  /** Replica node that acked. */
  readonly node: DeviceId;
}

export interface RebuildPayload {
  readonly eg: string;
  readonly from: DeviceId;
  readonly to: DeviceId;
}

export interface RebuildAckPayload {
  /** Id of the `hci-rebuild` frame being acked. */
  readonly ref: string;
}

export function isPayload<T extends object>(p: unknown, key: keyof T): p is T {
  return typeof p === 'object' && p !== null && key in p;
}
