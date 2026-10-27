/**
 * Typed predicates over `Snapshot`, built on the view-field contract (`docs/view-fields.md`).
 * Readers throw on a missing or mistyped field, so contract drift fails loudly with a precise
 * message instead of silently evaluating to `false`.
 */
import type {
  DeviceView,
  DropReason,
  SimEvent,
  SimTime,
  Snapshot,
  ViewField,
} from '../engine/types';
import { type CtxPredicate, type Predicate, type ScenarioContext, withCtx } from './context';
import type { Expectation } from './define';
import { cvmId, nodeId } from './ids';

// ── Time conventions ─────────────────────────────────────────────────────────
// An action queued at `at: T` applies at the start of the next tick, so it is in effect from
// snapshot T+1. "T+x" in narratives therefore means tick T+1+x.

/** Default injection time: queued at t=10 so paths, sessions and leaders are settled. */
export const T0 = 10;
/** Tolerance in ticks for detection/delivery jitter around a modeled timer. */
export const SLACK = 2;
/** Tick by which something due `x` s after an injection at `from` must have happened. */
export const by = (x: number, from: SimTime = T0): SimTime => from + 1 + x + SLACK;
/** Last tick at which something due `x` s after an injection at `from` must not have happened. */
export const before = (x: number, from: SimTime = T0): SimTime =>
  Math.max(from + 1, from + x - SLACK);

// ── Field readers ────────────────────────────────────────────────────────────

function fieldOf(d: DeviceView, key: string): ViewField {
  const v = d.fields[key];
  if (v === undefined) throw new Error(`${d.id} (${d.kind}): missing view field "${key}"`);
  return v;
}

function mistyped(d: DeviceView, key: string, want: string, v: unknown): Error {
  return new Error(`${d.id} (${d.kind}).${key}: expected ${want}, got ${JSON.stringify(v)}`);
}

export function str(d: DeviceView, key: string): string {
  const v = fieldOf(d, key);
  if (typeof v !== 'string') throw mistyped(d, key, 'string', v);
  return v;
}

export function num(d: DeviceView, key: string): number {
  const v = fieldOf(d, key);
  if (typeof v !== 'number') throw mistyped(d, key, 'number', v);
  return v;
}

export function bool(d: DeviceView, key: string): boolean {
  const v = fieldOf(d, key);
  if (typeof v !== 'boolean') throw mistyped(d, key, 'boolean', v);
  return v;
}

export function strOrNull(d: DeviceView, key: string): string | null {
  const v = fieldOf(d, key);
  if (v !== null && typeof v !== 'string') throw mistyped(d, key, 'string | null', v);
  return v;
}

export function numOrNull(d: DeviceView, key: string): number | null {
  const v = fieldOf(d, key);
  if (v !== null && typeof v !== 'number') throw mistyped(d, key, 'number | null', v);
  return v;
}

function oneOf<T extends string>(d: DeviceView, key: string, allowed: readonly T[]): T {
  const v = str(d, key);
  const match = allowed.find((a) => a === v);
  if (match === undefined) throw mistyped(d, key, allowed.join(' | '), v);
  return match;
}

function oneOfOrNull<T extends string>(
  d: DeviceView,
  key: string,
  allowed: readonly T[],
): T | null {
  return fieldOf(d, key) === null ? null : oneOf(d, key, allowed);
}

function parseJson(d: DeviceView, key: string): unknown {
  const raw = strOrNull(d, key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw mistyped(d, key, 'JSON string', raw);
  }
}

/** A JSON-encoded string array field (`null` reads as empty). */
export function jsonList(d: DeviceView, key: string): string[] {
  const v = parseJson(d, key);
  if (v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw mistyped(d, key, 'JSON string[]', v);
  }
  return v;
}

/** A JSON-encoded `Record<string, string>` field (`null` reads as empty). */
export function jsonMap(d: DeviceView, key: string): Record<string, string> {
  const v = parseJson(d, key);
  if (v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw mistyped(d, key, 'JSON object', v);
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== 'string') throw mistyped(d, key, 'JSON Record<string, string>', v);
    out[k] = x;
  }
  return out;
}

// ── Devices ──────────────────────────────────────────────────────────────────

export function device(s: Snapshot, id: string): DeviceView {
  const d = s.devices[id];
  if (!d) throw new Error(`t=${s.simTime}: no device "${id}" in snapshot (${s.topologyId})`);
  return d;
}

export function devicesOfKind(s: Snapshot, kind: string): DeviceView[] {
  return Object.values(s.devices)
    .filter((d) => d.kind === kind)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const hostRef = (n: number | string): string => (typeof n === 'number' ? nodeId(n) : n);
const cvmRef = (n: number | string): string => (typeof n === 'number' ? cvmId(n) : n);

// vm ───────────────────────────────────────────────────────────────────────────

export const VM_STATES = [
  'running',
  'io-stalled',
  'paused',
  'crashed',
  'restarting',
  'off',
] as const;
export type VmState = (typeof VM_STATES)[number];

export interface VmView {
  readonly id: string;
  readonly state: VmState;
  readonly host: string | null;
  readonly instances: readonly string[];
  readonly ioPendingS: number;
  readonly readPendingS: number;
  readonly writePendingS: number;
  readonly ownerCvm: string | null;
  readonly ioPaths: readonly string[];
  readonly ioUplinks: readonly string[];
}

function readVm(d: DeviceView): VmView {
  return {
    id: d.id,
    state: oneOf(d, 'state', VM_STATES),
    host: strOrNull(d, 'host'),
    instances: jsonList(d, 'instances'),
    ioPendingS: num(d, 'ioPendingS'),
    readPendingS: num(d, 'readPendingS'),
    writePendingS: num(d, 'writePendingS'),
    ownerCvm: strOrNull(d, 'ownerCvm'),
    ioPaths: jsonList(d, 'ioPaths'),
    ioUplinks: jsonList(d, 'ioUplinks'),
  };
}

export const vm = (s: Snapshot, id: string): VmView => readVm(device(s, id));
export const vms = (s: Snapshot): VmView[] => devicesOfKind(s, 'vm').map(readVm);
export const allVms = (s: Snapshot, pred: (v: VmView) => boolean): boolean => vms(s).every(pred);
/** VMs defined on node `n` (by id prefix; they keep their id after an HA restart). */
export const vmsOfNode = (s: Snapshot, n: number | string): VmView[] =>
  vms(s).filter((v) => v.id.startsWith(`${hostRef(n)}.vm-`));
/** VMs currently placed on a host. */
export const vmsOnHost = (s: Snapshot, n: number | string): VmView[] =>
  vms(s).filter((v) => v.host === hostRef(n));
export const isRunning = (v: VmView): boolean => v.state === 'running';
/** Stalled or paused: alive, but its IO is not completing. */
export const isStalled = (v: VmView): boolean => v.state === 'io-stalled' || v.state === 'paused';

// cvm ──────────────────────────────────────────────────────────────────────────

export const STARGATE_STATES = ['up', 'down', 'unhealthy'] as const;
export const PATH_STATES = ['live', 'lost', 'removed'] as const;
export type PathState = (typeof PATH_STATES)[number];
export const RING_STATES = ['normal', 'down', 'detached'] as const;

export interface CvmView {
  readonly id: string;
  readonly state: 'up' | 'down';
  readonly stargate: (typeof STARGATE_STATES)[number];
  readonly nvmePathsUp: number | null;
  readonly nvmePathsTotal: number | null;
  /** pathId (`<cvm-interface>~<fa-interface>`) → state; empty outside T1. */
  readonly nvmePaths: Readonly<Record<string, PathState>>;
  readonly zkMember: boolean;
  readonly zkQuorum: boolean;
  readonly zkPartition: string | null;
  readonly ringState: (typeof RING_STATES)[number];
}

function readCvm(d: DeviceView): CvmView {
  const raw = jsonMap(d, 'nvmePaths');
  const nvmePaths: Record<string, PathState> = {};
  for (const [k, v] of Object.entries(raw)) {
    const st = PATH_STATES.find((p) => p === v);
    if (st === undefined) throw mistyped(d, `nvmePaths[${k}]`, PATH_STATES.join(' | '), v);
    nvmePaths[k] = st;
  }
  return {
    id: d.id,
    state: oneOf(d, 'state', ['up', 'down'] as const),
    stargate: oneOf(d, 'stargate', STARGATE_STATES),
    nvmePathsUp: numOrNull(d, 'nvmePathsUp'),
    nvmePathsTotal: numOrNull(d, 'nvmePathsTotal'),
    nvmePaths,
    zkMember: bool(d, 'zkMember'),
    zkQuorum: bool(d, 'zkQuorum'),
    zkPartition: strOrNull(d, 'zkPartition'),
    ringState: oneOf(d, 'ringState', RING_STATES),
  };
}

export const cvm = (s: Snapshot, n: number | string): CvmView => readCvm(device(s, cvmRef(n)));
export const cvms = (s: Snapshot): CvmView[] => devicesOfKind(s, 'cvm').map(readCvm);
export const allCvms = (s: Snapshot, pred: (c: CvmView) => boolean): boolean => cvms(s).every(pred);
export const cvmPathsUp = (s: Snapshot, n: number | string): number => cvm(s, n).nvmePathsUp ?? 0;
/** All of this CVM's NVMe paths are live (and it has some). */
export const allPathsLive = (c: CvmView): boolean =>
  (c.nvmePathsTotal ?? 0) > 0 && c.nvmePathsUp === c.nvmePathsTotal;

/** Path states of `c` whose FA end satisfies `remote` (and local end satisfies `local`). */
export function pathStates(
  c: CvmView,
  remote: (faIface: string) => boolean,
  local: (cvmIface: string) => boolean = () => true,
): PathState[] {
  const out: PathState[] = [];
  for (const [id, st] of Object.entries(c.nvmePaths)) {
    const [l, r] = id.split('~');
    if (l !== undefined && r !== undefined && local(l) && remote(r)) out.push(st);
  }
  return out;
}

/**
 * Exactly the paths whose FA end is in `lostRemotes` are not live, and every other path is.
 * Requires at least one path on each side of the split so a vacuous match can't pass.
 */
export function onlyPathsLostTo(c: CvmView, lostRemotes: readonly string[]): boolean {
  const lost = pathStates(c, (r) => lostRemotes.includes(r));
  const kept = pathStates(c, (r) => !lostRemotes.includes(r));
  return (
    lost.length > 0 &&
    lost.every((p) => p !== 'live') &&
    kept.length > 0 &&
    kept.every((p) => p === 'live')
  );
}

/** CVM storage interfaces (`cvm-interface` with service `external-storage`) on node `n`. */
export const cvmStorageInterfaces = (s: Snapshot, n: number | string): DeviceView[] =>
  devicesOfKind(s, 'cvm-interface').filter(
    (d) => d.parent === cvmRef(n) && str(d, 'service') === 'external-storage',
  );

// ahv-host ─────────────────────────────────────────────────────────────────────

export const HOST_ROLES = [
  'hci',
  'compute-only',
  'storage-only',
  'external-storage-compute',
] as const;
export const HA_STATES = ['connected', 'disconnected', 'fenced'] as const;

export interface HostView {
  readonly id: string;
  readonly power: 'on' | 'off';
  readonly role: (typeof HOST_ROLES)[number];
  readonly haState: (typeof HA_STATES)[number];
  readonly badges: readonly string[];
}

function readHost(d: DeviceView): HostView {
  return {
    id: d.id,
    power: oneOf(d, 'power', ['on', 'off'] as const),
    role: oneOf(d, 'role', HOST_ROLES),
    haState: oneOf(d, 'haState', HA_STATES),
    badges: d.badges,
  };
}

export const host = (s: Snapshot, n: number | string): HostView => readHost(device(s, hostRef(n)));
export const hosts = (s: Snapshot): HostView[] => devicesOfKind(s, 'ahv-host').map(readHost);
export const isFenced = (s: Snapshot, hostId: string): boolean =>
  host(s, hostId).haState === 'fenced';
/** The VM runs on a host of one of these roles. */
export const vmOnRole = (s: Snapshot, v: VmView, roles: readonly HostView['role'][]): boolean =>
  v.host !== null && roles.includes(host(s, v.host).role);

// vswitch ──────────────────────────────────────────────────────────────────────

export const BOND_MODES = ['active-backup', 'balance-slb', 'balance-tcp', 'no-bond'] as const;
export type BondMode = (typeof BOND_MODES)[number];
export const LACP_STATES = ['negotiated', 'partial', 'fallback', 'down'] as const;

export interface VSwitchView {
  readonly id: string;
  readonly bondMode: BondMode;
  readonly lacpRate: 'fast' | 'slow' | null;
  readonly lacpState: (typeof LACP_STATES)[number] | null;
  readonly members: readonly string[];
  readonly activeMembers: number;
  readonly activeMember: string | null;
  /** vNIC id → member NIC id (balance-slb / active-backup); empty for balance-tcp. */
  readonly pinning: Readonly<Record<string, string>>;
}

export function vswitch(s: Snapshot, id: string): VSwitchView {
  const d = device(s, id);
  return {
    id,
    bondMode: oneOf(d, 'bondMode', BOND_MODES),
    lacpRate: oneOfOrNull(d, 'lacpRate', ['fast', 'slow'] as const),
    lacpState: oneOfOrNull(d, 'lacpState', LACP_STATES),
    members: jsonList(d, 'members'),
    activeMembers: num(d, 'activeMembers'),
    activeMember: strOrNull(d, 'activeMember'),
    pinning: jsonMap(d, 'pinning'),
  };
}

// FlashArray ───────────────────────────────────────────────────────────────────

export const FA_ROLES = ['primary', 'secondary', 'promoting', 'offline'] as const;
export const FA_CONTROLLER_STATES = ['up', 'crashed', 'rebooting', 'stalled'] as const;

export interface FaArrayView {
  readonly ioServing: boolean;
  readonly pauseS: number;
  readonly primary: string | null;
  readonly mgmtApi: 'up' | 'unreachable';
}

export function fa(s: Snapshot, id = 'fa'): FaArrayView {
  const d = device(s, id);
  return {
    ioServing: bool(d, 'ioServing'),
    pauseS: num(d, 'pauseS'),
    primary: strOrNull(d, 'primary'),
    mgmtApi: oneOf(d, 'mgmtApi', ['up', 'unreachable'] as const),
  };
}

export interface FaControllerView {
  readonly id: string;
  readonly role: (typeof FA_ROLES)[number];
  readonly state: (typeof FA_CONTROLLER_STATES)[number];
}

export function faController(s: Snapshot, id: string): FaControllerView {
  const d = device(s, id);
  return {
    id,
    role: oneOf(d, 'role', FA_ROLES),
    state: oneOf(d, 'state', FA_CONTROLLER_STATES),
  };
}

export interface FaInterfaceView {
  readonly id: string;
  readonly controller: string | null;
  readonly nic: string;
  readonly vlan: number;
  readonly service: string;
  readonly enabled: boolean;
  readonly oper: 'up' | 'down';
}

function readFaInterface(d: DeviceView): FaInterfaceView {
  return {
    id: d.id,
    controller: d.parent !== undefined ? d.parent.split('.').slice(0, 2).join('.') : null,
    nic: str(d, 'nic'),
    vlan: num(d, 'vlan'),
    service: str(d, 'service'),
    enabled: bool(d, 'enabled'),
    oper: oneOf(d, 'oper', ['up', 'down'] as const),
  };
}

/** NVMe/TCP data interfaces on the array. */
export const faDataInterfaces = (s: Snapshot): FaInterfaceView[] =>
  devicesOfKind(s, 'fa-interface')
    .map(readFaInterface)
    .filter((i) => i.service === 'nvme-tcp');

/** Ids of FA data interfaces whose port is cabled to `switchId`. */
export function faInterfacesBehind(s: Snapshot, switchId: string): string[] {
  const ports = new Set<string>();
  for (const l of Object.values(s.links)) {
    if (l.b.device === switchId) ports.add(l.a.device);
    if (l.a.device === switchId) ports.add(l.b.device);
  }
  return faDataInterfaces(s)
    .filter((i) => ports.has(i.nic))
    .map((i) => i.id);
}

/** FA data interface ids hosted on a controller (`fa.ct0` → `fa.ct0.…`). */
export const faInterfacesOn = (s: Snapshot, controller: string): string[] =>
  faDataInterfaces(s)
    .filter((i) => i.id.startsWith(`${controller}.`))
    .map((i) => i.id);

// disk ─────────────────────────────────────────────────────────────────────────

export const DISK_STATES = ['online', 'offline', 'smart-check', 'failed'] as const;

export interface DiskView {
  readonly id: string;
  readonly state: (typeof DISK_STATES)[number];
  readonly offlineEventsLastHour: number;
}

export function disk(s: Snapshot, id: string): DiskView {
  const d = device(s, id);
  return {
    id,
    state: oneOf(d, 'state', DISK_STATES),
    offlineEventsLastHour: num(d, 'offlineEventsLastHour'),
  };
}

// links ────────────────────────────────────────────────────────────────────────

/** Messages delivered over a link during the last tick, all categories. */
export function linkLoad(s: Snapshot, id: string): number {
  const l = s.links[id];
  if (!l) throw new Error(`t=${s.simTime}: no link "${id}" in snapshot`);
  return Object.values(l.util).reduce((a, b) => a + b, 0);
}

export const droppedThisTick = (s: Snapshot, reason: DropReason): number =>
  s.traces.filter((t) => t.result === 'dropped' && t.reason === reason).length;

// derived ──────────────────────────────────────────────────────────────────────

export const HA_STATUSES = ['OK', 'Healing', 'Critical'] as const;
export const RESILIENCY = ['OK', 'Rebuilding', 'Critical'] as const;

export interface DerivedView {
  readonly haStatus: (typeof HA_STATUSES)[number];
  readonly zkQuorum: boolean;
  readonly zkLeader: string | null;
  readonly acropolisLeader: string | null;
  readonly resiliency: (typeof RESILIENCY)[number];
  readonly nodeFailureTolerance: number;
  readonly ftConfigured: number;
  readonly metadataAvailable: boolean;
  readonly dataAvailable: boolean;
  readonly underReplicated: number;
  readonly clusterServices: 'up' | 'down';
  readonly blockAwareness: 'met' | 'not-met' | 'off';
}

function derivedField(s: Snapshot, key: string): ViewField {
  const v = s.derived[key];
  if (v === undefined) throw new Error(`t=${s.simTime}: missing derived field "${key}"`);
  if (typeof v === 'object' && v !== null) {
    throw new Error(`t=${s.simTime}: derived "${key}" is a record, expected a scalar`);
  }
  return v;
}

/** Read the derived block through the same typed readers as device fields. */
export function derived(s: Snapshot): DerivedView {
  const fields: Record<string, ViewField> = {};
  for (const k of Object.keys(s.derived)) fields[k] = derivedField(s, k);
  const d: DeviceView = {
    id: 'derived',
    kind: 'cluster-derived',
    label: 'derived',
    status: 'unknown',
    badges: [],
    fields,
  };
  return {
    haStatus: oneOf(d, 'haStatus', HA_STATUSES),
    zkQuorum: bool(d, 'zkQuorum'),
    zkLeader: strOrNull(d, 'zkLeader'),
    acropolisLeader: strOrNull(d, 'acropolisLeader'),
    resiliency: oneOf(d, 'resiliency', RESILIENCY),
    nodeFailureTolerance: num(d, 'nodeFailureTolerance'),
    ftConfigured: num(d, 'ftConfigured'),
    metadataAvailable: bool(d, 'metadataAvailable'),
    dataAvailable: bool(d, 'dataAvailable'),
    underReplicated: num(d, 'underReplicated'),
    clusterServices: oneOf(d, 'clusterServices', ['up', 'down'] as const),
    blockAwareness: oneOf(d, 'blockAwareness', ['met', 'not-met', 'off'] as const),
  };
}

/** Cluster storage is fully available: ZK quorum, metadata and every extent group reachable. */
export function storageAvailable(s: Snapshot): boolean {
  const d = derived(s);
  return d.zkQuorum && d.metadataAvailable && d.dataAvailable;
}

// ── Invariants (SPEC §7.1) ───────────────────────────────────────────────────

/** No VM has a live process on more than one host. */
export const noVmRunningTwice = (s: Snapshot): boolean =>
  vms(s).every((v) => new Set(v.instances).size === v.instances.length && v.instances.length <= 1);

/** No VM completes IO from a fenced host, and no fenced host's CVM owns a running VM's vDisks. */
export function ioNeverServedByFencedHost(s: Snapshot): boolean {
  const fenced = new Set(
    hosts(s)
      .filter((h) => h.haState === 'fenced')
      .map((h) => h.id),
  );
  return vms(s).every((v) => {
    if (v.host !== null && fenced.has(v.host) && v.state === 'running') return false;
    const ownerHost = v.ownerCvm?.split('.')[0];
    return !(v.state === 'running' && ownerHost !== undefined && fenced.has(ownerHost));
  });
}

/** At most one ZK partition claims quorum. */
export function zkQuorumUnique(s: Snapshot): boolean {
  const sides = new Set(
    cvms(s)
      .filter((c) => c.zkQuorum)
      .map((c) => c.zkPartition),
  );
  return sides.size <= 1;
}

/** No VM is ever placed on a storage-only node (AHV Admin Guide 11.2). */
export const noVmOnStorageOnly = (s: Snapshot): boolean =>
  vms(s).every((v) => !vmOnRole(s, v, ['storage-only']));

// ── Context (history) helpers ────────────────────────────────────────────────

export interface EventFilter {
  readonly device?: string;
  /** Inclusive tick bounds. */
  readonly from?: SimTime;
  readonly to?: SimTime;
}

export function eventsMatching(
  ctx: ScenarioContext,
  code: string,
  f: EventFilter = {},
): SimEvent[] {
  return ctx.events.filter(
    (e) =>
      e.code === code &&
      (f.device === undefined || e.deviceId === f.device) &&
      (f.from === undefined || e.t >= f.from) &&
      (f.to === undefined || e.t <= f.to),
  );
}

export const eventSeen = (ctx: ScenarioContext, code: string, f: EventFilter = {}): boolean =>
  eventsMatching(ctx, code, f).length > 0;

export const firstEventAt = (
  ctx: ScenarioContext,
  code: string,
  f: EventFilter = {},
): SimTime | null => eventsMatching(ctx, code, f)[0]?.t ?? null;

/** The codes (optionally per device) occur in this order, as a subsequence of the log. */
export function eventsInOrder(
  ctx: ScenarioContext,
  steps: readonly { readonly code: string; readonly device?: string }[],
): boolean {
  let i = 0;
  for (const e of ctx.events) {
    const want = steps[i];
    if (!want) break;
    if (e.code === want.code && (want.device === undefined || e.deviceId === want.device)) i++;
  }
  return i === steps.length;
}

export function snapshotAt(ctx: ScenarioContext, t: SimTime): Snapshot {
  const s = ctx.history.find((h) => h.simTime === t);
  if (!s) throw new Error(`no snapshot at t=${t} in history`);
  return s;
}

/** `pred` held on at least one snapshot in [from, to]. */
export const wasEver = (
  ctx: ScenarioContext,
  pred: Predicate,
  from: SimTime = 0,
  to: SimTime = ctx.now,
): boolean => ctx.history.some((h) => h.simTime >= from && h.simTime <= to && pred(h));

// ── Expectation builders ─────────────────────────────────────────────────────

export const at = (t: SimTime, label: string, that: Predicate): Expectation => ({
  label,
  at: t,
  that,
});
export const atCtx = (t: SimTime, label: string, fn: CtxPredicate): Expectation => ({
  label,
  at: t,
  that: withCtx(fn),
});
export const always = (label: string, that: Predicate): Expectation => ({
  label,
  always: true,
  that,
});
/** Holds on every tick from `t` on. */
export const alwaysFrom = (t: SimTime, label: string, that: Predicate): Expectation =>
  always(label, (s) => s.simTime < t || that(s));

/** Invariants every scenario carries (SPEC §7.1). */
export const baseInvariants = (): Expectation[] => [
  always('no VM runs on two hosts', noVmRunningTwice),
  always('IO is never served by a fenced host', ioNeverServedByFencedHost),
  always('at most one ZK quorum side', zkQuorumUnique),
];

/** T1 steady state at `t`: every VM running, every CVM with all its NVMe paths live. */
export const t1Steady = (t: SimTime = T0): Expectation[] => [
  at(t, 'steady state: all VMs running', (s) => allVms(s, isRunning)),
  at(t, 'steady state: every CVM has all NVMe paths live', (s) => allCvms(s, allPathsLive)),
];

export const allRunningAt = (t: SimTime, label = 'all VMs running'): Expectation =>
  at(t, label, (s) => allVms(s, isRunning));

/** Not seen at any point in the run (checked at `end`). */
export const neverSeen = (end: SimTime, code: string, f: EventFilter = {}): Expectation =>
  atCtx(
    end,
    `no ${code}${f.device ? ` on ${f.device}` : ''}`,
    (_s, ctx) => !eventSeen(ctx, code, f),
  );
