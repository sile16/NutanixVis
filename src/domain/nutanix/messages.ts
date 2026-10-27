/**
 * Message kinds stream F sends. Each kind equals its traffic category (SPEC §5.4), so packets are
 * colored correctly even before the loader registers `traffic`.
 */
import type { IoOutcome, IoRequest } from '../contracts';

export const MSG = {
  /** iSCSI redirector ↔ Stargate health check (Bible 5b). */
  nop: 'iscsi-nop',
  /** Acropolis leader ↔ host libvirtd heartbeat (Bible 5b). */
  haPoll: 'ha-poll',
  /** Zookeeper ensemble / client session traffic between CVMs. */
  zk: 'zk',
  /** VM (QEMU iSCSI initiator, via the redirector) ↔ Stargate. */
  ioRead: 'io-read',
  ioWrite: 'io-write',
} as const;

export const TRAFFIC: Readonly<Record<string, string>> = {
  [MSG.nop]: 'iscsi-nop',
  [MSG.haPoll]: 'ha-poll',
  [MSG.zk]: 'zk',
  [MSG.ioRead]: 'io-read',
  [MSG.ioWrite]: 'io-write',
};

/** Well-known L4 ports (illustrative; they only feed bond hashing). */
export const PORT = { iscsi: 3260, libvirt: 16509, zk: 2888 } as const;

export interface PingPayload {
  readonly t: 'req' | 'resp';
  /** Sender device (host or CVM). */
  readonly from: string;
}

export interface IoReqPayload {
  readonly t: 'req';
  readonly io: IoRequest;
  /** AHV host the IO comes from (fencing is per host). */
  readonly host: string;
}

/** `retry`: refused for now (fenced host, no ZK quorum); the initiator resends it. */
export type IoReply = IoOutcome | { readonly status: 'retry'; readonly reason: string };

export interface IoRespPayload {
  readonly t: 'resp';
  readonly ioId: string;
  readonly vm: string;
  readonly cvm: string;
  readonly reply: IoReply;
}

export type IoPayload = IoReqPayload | IoRespPayload;

export function isIoKind(kind: string): boolean {
  return kind === MSG.ioRead || kind === MSG.ioWrite;
}

/** Stable small hash for per-session source ports. */
export function portFor(key: string, base = 40000): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return base + (h % 20000);
}
