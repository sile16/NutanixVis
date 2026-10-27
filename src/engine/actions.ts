/**
 * Action registry (SPEC §5.5). Each action has an `ActionSpec` (what the UI offers, filtered by
 * `appliesTo`) and an `apply` that runs at the start of the next tick (SPEC §5.2 phase 1).
 * The engine registers generic and network actions; domain modules register their own.
 */
import type { NetworkQuery, NetworkRuntime } from './network/runtime';
import { BOND_MODES, type BondMode, type LacpRate } from './network/spec';
import type {
  ActionKind,
  ActionRequest,
  ActionSpec,
  DeviceId,
  DeviceView,
  EventDraft,
  LinkView,
  SimTime,
} from './types';

/** Thrown by `apply` for bad parameters; the simulation logs it as `action.rejected`. */
export class ActionError extends Error {
  override readonly name = 'ActionError';
}

export interface ActionContext {
  readonly now: SimTime;
  /** The `action.applied` event id; cite it as the cause of follow-on events. */
  readonly causeIds: readonly string[];
  readonly net: NetworkRuntime;
  failDevice(id: DeviceId): void;
  recoverDevice(id: DeviceId): void;
  isFailed(id: DeviceId): boolean;
  emit(event: EventDraft): string;
}

export interface ActionDefinition {
  readonly spec: ActionSpec;
  apply(req: ActionRequest, ctx: ActionContext): void;
}

export type ActionTarget = DeviceView | LinkView;

export function isLinkView(t: ActionTarget): t is LinkView {
  return 'a' in t && 'b' in t && 'util' in t;
}

export class ActionRegistry {
  private readonly defs = new Map<ActionKind, ActionDefinition>();

  constructor(defs: readonly ActionDefinition[] = []) {
    for (const d of defs) this.register(d);
  }

  register(def: ActionDefinition): this {
    if (this.defs.has(def.spec.kind)) {
      throw new Error(`action '${def.spec.kind}' is already registered`);
    }
    this.defs.set(def.spec.kind, def);
    return this;
  }

  get(kind: ActionKind): ActionDefinition | undefined {
    return this.defs.get(kind);
  }

  specs(): readonly ActionSpec[] {
    return [...this.defs.values()].map((d) => d.spec);
  }

  /** Specs whose `appliesTo` accepts `target`, in registration order. */
  applicable(target: ActionTarget): readonly ActionSpec[] {
    return this.specs().filter((s) => s.appliesTo(target));
  }
}

// ── Parameter helpers ────────────────────────────────────────────────────────

function raw(req: ActionRequest, name: string): string | number | boolean | undefined {
  return req.params?.[name];
}

export function stringParam<T extends string>(
  req: ActionRequest,
  name: string,
  choices?: readonly T[],
): T {
  const v = raw(req, name);
  if (typeof v !== 'string') throw new ActionError(`${req.kind}: param '${name}' must be a string`);
  if (choices && !(choices as readonly string[]).includes(v)) {
    throw new ActionError(`${req.kind}: '${v}' is not one of ${choices.join(', ')}`);
  }
  return v as T;
}

export function optionalStringParam(req: ActionRequest, name: string): string | undefined {
  const v = raw(req, name);
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new ActionError(`${req.kind}: param '${name}' must be a string`);
  return v;
}

export function numberParam(req: ActionRequest, name: string): number {
  const v = raw(req, name);
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new ActionError(`${req.kind}: param '${name}' must be a number`);
  }
  return n;
}

export function boolParam(req: ActionRequest, name: string): boolean {
  const v = raw(req, name);
  if (v === true || v === 'on' || v === 'true') return true;
  if (v === false || v === 'off' || v === 'false') return false;
  throw new ActionError(`${req.kind}: param '${name}' must be on/off`);
}

// ── Built-in generic and network actions ─────────────────────────────────────

export interface BuiltinEnv {
  readonly net: NetworkQuery;
  isFailed(id: DeviceId): boolean;
}

/** Generic device/link actions plus the engine-level network config actions of SPEC §5.5. */
export function builtinActions(env: BuiltinEnv): ActionDefinition[] {
  const { net } = env;
  const isDevice = (t: ActionTarget): t is DeviceView => !isLinkView(t);
  const isBond = (t: ActionTarget) => isDevice(t) && net.kindOf(t.id) === 'bond';
  const isSwitch = (t: ActionTarget) => isDevice(t) && net.kindOf(t.id) === 'switch';
  const hangable = (t: ActionTarget) => {
    const k = net.kindOf(t.id);
    return k === 'link' || k === 'nic' || k === 'switch';
  };
  const hasSwitchEnd = (t: ActionTarget) =>
    isLinkView(t) && (net.kindOf(t.a.device) === 'switch' || net.kindOf(t.b.device) === 'switch');
  const vlans = net.vlans();

  const forGroup = (target: string, fn: (bond: string) => void) => {
    for (const id of net.bondsInGroup(target)) fn(id);
  };

  return [
    {
      spec: {
        kind: 'fail',
        label: 'Fail',
        description: 'Hard failure: the device, its children and their ports go down.',
        appliesTo: (t) => isDevice(t) && !isBond(t) && !env.isFailed(t.id),
      },
      apply: (req, ctx) => ctx.failDevice(req.target),
    },
    {
      spec: {
        kind: 'recover',
        label: 'Recover',
        appliesTo: (t) => isDevice(t) && env.isFailed(t.id),
      },
      apply: (req, ctx) => ctx.recoverDevice(req.target),
    },
    {
      spec: {
        kind: 'link-down',
        label: 'Link down',
        description: 'Pull the cable: both ends lose carrier.',
        appliesTo: (t) => isLinkView(t) && net.isAdminUp(t.id),
      },
      apply: (req, ctx) => ctx.net.setLinkUp(req.target, false),
    },
    {
      spec: {
        kind: 'link-up',
        label: 'Link up',
        appliesTo: (t) => isLinkView(t) && !net.isAdminUp(t.id),
      },
      apply: (req, ctx) => ctx.net.setLinkUp(req.target, true),
    },
    {
      spec: {
        kind: 'hang',
        label: 'Hang (no carrier loss)',
        description:
          'Carrier stays up but frames are dropped (hung switch, unidirectional link). Only LACP detects this.',
        appliesTo: (t) => hangable(t) && !net.isHung(t.id),
      },
      apply: (req, ctx) => ctx.net.setHung(req.target, true),
    },
    {
      spec: {
        kind: 'unhang',
        label: 'Clear hang',
        appliesTo: (t) => hangable(t) && net.isHung(t.id),
      },
      apply: (req, ctx) => ctx.net.setHung(req.target, false),
    },
    {
      spec: {
        kind: 'set-latency',
        label: 'Set latency',
        appliesTo: isLinkView,
        params: { ms: { label: 'Latency (ms, illustrative)', choices: [0, 1, 2, 5, 10, 50, 100] } },
      },
      apply: (req, ctx) => ctx.net.setLinkLatency(req.target, numberParam(req, 'ms')),
    },
    {
      spec: {
        kind: 'switch.port.prune-vlan',
        label: 'Prune VLAN from switch port',
        appliesTo: hasSwitchEnd,
        params: { vlan: { label: 'VLAN', choices: vlans } },
      },
      apply: (req, ctx) => ctx.net.pruneVlan(req.target, numberParam(req, 'vlan')),
    },
    {
      spec: {
        kind: 'switch.port.allow-vlan',
        label: 'Allow VLAN on switch port',
        appliesTo: (t) => hasSwitchEnd(t) && net.link(t.id)?.allowedVlans !== null,
        params: { vlan: { label: 'VLAN', choices: vlans } },
      },
      apply: (req, ctx) => ctx.net.allowVlan(req.target, numberParam(req, 'vlan')),
    },
    {
      spec: {
        kind: 'vswitch.set-bond-mode',
        label: 'Set bond mode',
        description:
          'Applies to every host on this virtual switch: mixed bond modes are not supported.',
        appliesTo: isBond,
        params: { mode: { label: 'Bond mode', choices: BOND_MODES } },
      },
      apply: (req, ctx) => {
        const mode = stringParam<BondMode>(req, 'mode', BOND_MODES);
        forGroup(req.target, (id) => ctx.net.setBondMode(id, mode));
      },
    },
    {
      spec: {
        kind: 'vswitch.set-uplinks',
        label: 'Set uplinks',
        description:
          'Comma-separated NIC ids, chosen from the bond’s cabled members (empty = none).',
        appliesTo: isBond,
        params: { uplinks: { label: 'Uplink NICs (comma-separated)', choices: [] } },
      },
      apply: (req, ctx) => {
        const csv = stringParam(req, 'uplinks');
        const uplinks = csv
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');
        ctx.net.setBondUplinks(req.target, uplinks);
      },
    },
    {
      spec: {
        kind: 'vswitch.set-lacp-rate',
        label: 'Set LACP rate',
        appliesTo: isBond,
        params: { rate: { label: 'LACP rate', choices: ['fast', 'slow'] } },
      },
      apply: (req, ctx) => {
        const rate = stringParam<LacpRate>(req, 'rate', ['fast', 'slow']);
        forGroup(req.target, (id) => ctx.net.setLacpRate(id, rate));
      },
    },
    {
      spec: {
        kind: 'vswitch.rebalance',
        label: 'Force MAC-pinning rebalance',
        description:
          'Move one vNIC (source MAC) onto a member, as a balance-slb load rebalance would. Plain OVS: the move ignores which VLANs the member’s switch carries.',
        appliesTo: (t) => isBond(t) && net.bond(t.id)?.mode === 'balance-slb',
        params: {
          vnic: { label: 'vNIC endpoint', choices: [] },
          member: { label: 'Member NIC', choices: [] },
        },
      },
      apply: (req, ctx) => {
        ctx.net.forceSlbPin(req.target, stringParam(req, 'vnic'), stringParam(req, 'member'));
      },
    },
    {
      spec: {
        kind: 'vswitch.set-slb-vlan-aware',
        label: 'Set VLAN-aware member selection',
        description:
          'On: MAC pinning and active-backup only use uplinks that carry the VLAN. Off: plain OVS, which can pin a VLAN onto an uplink that blackholes it.',
        appliesTo: isBond,
        params: { enabled: { label: 'VLAN-aware', choices: ['on', 'off'] } },
      },
      apply: (req, ctx) => {
        const on = boolParam(req, 'enabled');
        forGroup(req.target, (id) => ctx.net.setSlbVlanAware(id, on));
      },
    },
    {
      spec: {
        kind: 'fabric.set-mlag',
        label: 'Set MLAG',
        description: 'Turn MLAG on or off for this switch and its MLAG peers.',
        appliesTo: isSwitch,
        params: { enabled: { label: 'MLAG', choices: ['on', 'off'] } },
      },
      apply: (req, ctx) => {
        ctx.net.setMlag(req.target, boolParam(req, 'enabled'), optionalStringParam(req, 'domain'));
      },
    },
  ];
}
