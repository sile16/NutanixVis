/**
 * NVMe/TCP wire vocabulary shared by the CVM initiator (`initiator.ts`) and the FlashArray target
 * (`../flasharray`). Message kinds, payloads and traffic categories (SPEC §5.4, §6.4b–c).
 *
 * Each NVMe controller (path) is one admin-queue TCP connection plus `ioQueuesPerPath` IO-queue
 * connections, each with its own source port (NVMe/TCP spec: one TCP connection per queue), so
 * LACP hashing spreads them while MAC pinning keeps them on the vNIC's uplink (SPEC §6.4b).
 */
import type { DeviceId, EndpointId, MessageDraft, MsgSize } from '../../engine/types';
import type { IoOp } from '../contracts';

/** NVMe/TCP listens on 4420 (Everpure NET and CFG). */
export const NVME_TCP_PORT = 4420;
/** Purity REST API over HTTPS. */
export const FA_MGMT_PORT = 443;

export const NVME_MSG = {
  connect: 'nvme-connect',
  connectResp: 'nvme-connect-resp',
  keepAlive: 'nvme-keepalive',
  keepAliveResp: 'nvme-keepalive-resp',
  io: 'nvme-io',
  ioResp: 'nvme-io-resp',
  resv: 'nvme-resv',
  resvResp: 'nvme-resv-resp',
  /** TCP reset from the target: the frame arrived on an association it has torn down. */
  reset: 'nvme-tcp-reset',
  mgmt: 'fa-mgmt',
} as const;

/** Message kind → traffic category (UI legend: `nvme-io`, `nvme-keepalive`, `mgmt`). */
export const NVME_TRAFFIC: Readonly<Record<string, string>> = {
  [NVME_MSG.connect]: 'nvme-keepalive',
  [NVME_MSG.connectResp]: 'nvme-keepalive',
  [NVME_MSG.keepAlive]: 'nvme-keepalive',
  [NVME_MSG.keepAliveResp]: 'nvme-keepalive',
  [NVME_MSG.resv]: 'nvme-keepalive',
  [NVME_MSG.resvResp]: 'nvme-keepalive',
  [NVME_MSG.reset]: 'nvme-keepalive',
  [NVME_MSG.io]: 'nvme-io',
  [NVME_MSG.ioResp]: 'nvme-io',
  [NVME_MSG.mgmt]: 'mgmt',
};

/** Admin-queue messages: connect and keep-alive. `gen` identifies the association. */
export interface AdminPayload {
  readonly pathId: string;
  readonly gen: number;
  /** Host (CVM) that owns the association. */
  readonly host: DeviceId;
}

export interface ConnectRespPayload extends AdminPayload {
  readonly ok: boolean;
}

/**
 * One NVMe command on an IO queue. `key` is unique per attempt (`<cmd>#<attempt>`); `gen` is the
 * association (path generation) it was sent on, so the target can reset frames of a torn-down one.
 */
export type CommandPayload =
  | {
      readonly type: 'io';
      readonly key: string;
      readonly gen: number;
      readonly host: DeviceId;
      readonly vdisk: string;
      readonly op: IoOp;
      /** Data size class: rides the command for writes, the completion for reads. */
      readonly size: MsgSize;
    }
  | {
      readonly type: 'resv';
      readonly key: string;
      readonly gen: number;
      readonly host: DeviceId;
      readonly vdisk: string;
      /** Reservation Acquire (preempt) or Release (NVMe base spec, Reservations). */
      readonly action: 'acquire' | 'release';
    };

export type CommandStatus = 'ok' | 'reservation-conflict';

/** TCP reset (`NVME_MSG.reset`): the target no longer has the association `gen`. */
export interface ResetPayload {
  readonly host: DeviceId;
  readonly gen: number;
}

export interface CommandRespPayload {
  readonly key: string;
  readonly status: CommandStatus;
  /** Illustrative array service time plus the request's network latency. */
  readonly latencyMs: number;
  /** Seconds the array held the command (array-wide pause), 0 when served at once. */
  readonly heldS: number;
}

/** A reply before its flow is built: the sender reverses the request's L4 ports. */
export type ReplyDraft<P> = Omit<MessageDraft<P>, 'flow'> & {
  readonly srcPort: number;
  readonly dstPort: number;
};

/** A management API call from a CVM to the array VIP (`fa.vir0`). */
export interface MgmtPayload {
  readonly task: 'poll' | 'snapshot';
  readonly host: DeviceId;
  readonly vm?: DeviceId;
}

/** Path id per docs/view-fields.md: `<cvm-interface id>~<fa-interface id>`. */
export const pathIdOf = (local: EndpointId, remote: EndpointId): string => `${local}~${remote}`;
