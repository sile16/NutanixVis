/**
 * Inspector action forms (pure): which parameter choice reflects the target's current state, and
 * whether an applied action was rejected by the simulation.
 */
import type { ActionSpec, DeviceView, LinkView, SimEvent } from '../../engine/types';

type Choice = string | number;

const isLink = (v: DeviceView | LinkView): v is LinkView => 'a' in v && 'b' in v;

const onOff = (v: unknown): string | undefined =>
  typeof v === 'boolean' ? (v ? 'on' : 'off') : undefined;

/** The target's current value for an action parameter, when the view exposes it. */
export function currentParamValue(kind: string, key: string, view: DeviceView | LinkView): unknown {
  if (isLink(view)) {
    if (key === 'ms') return view.latencyMs;
    if (key === 'pct') return view.lossPct ?? 0;
    return undefined;
  }
  const f = view.fields;
  switch (key) {
    case 'mode':
      return f.bondMode ?? f.mode;
    case 'rate':
      return f.lacpRate;
    case 'gbps':
      return f.offeredLoad;
    case 'readPct':
      return f.readPct;
    case 'seconds':
      return f.pathLossForceShutdownS === null ? 'off' : f.pathLossForceShutdownS;
    case 'enabled':
      if (kind === 'fabric.set-mlag') {
        if ('mlagEnabled' in f) return onOff(f.mlagEnabled);
        return f.mlagDomain ? 'on' : 'off';
      }
      return onOff(f[key]);
    default:
      return f[key];
  }
}

/** The choice matching the current value, if any. */
export function currentChoice(
  spec: ActionSpec,
  key: string,
  view: DeviceView | LinkView,
): Choice | undefined {
  const cur = currentParamValue(spec.kind, key, view);
  if (cur === undefined || cur === null) return undefined;
  return spec.params?.[key]?.choices.find((c) => String(c) === String(cur));
}

/**
 * The VLANs that ride a cable, from its non-switch end: an array port's interfaces, or the
 * interfaces on the vSwitch a host NIC belongs to. Empty when that cannot be told.
 */
function cableVlans(view: LinkView, devices: Readonly<Record<string, DeviceView>>): Set<string> {
  const out = new Set<string>();
  for (const end of [view.a.device, view.b.device]) {
    const nic = devices[end];
    if (!nic || nic.kind === 'switch') continue;
    const vswitch = nic.fields.bond;
    for (const d of Object.values(devices)) {
      const on =
        (d.kind === 'fa-interface' && d.parent === nic.id) ||
        ((d.kind === 'cvm-interface' || d.kind === 'host-interface') &&
          typeof vswitch === 'string' &&
          d.fields.vswitch === vswitch);
      if (on && d.fields.vlan !== undefined && d.fields.vlan !== null)
        out.add(String(d.fields.vlan));
    }
  }
  return out;
}

/**
 * Pruning a VLAN off a cable's switch port: start on a VLAN that rides that cable (else one its
 * switch carries). The engine offers every VLAN in the topology, including ones no port carries.
 */
function carriedVlan(
  spec: ActionSpec,
  key: string,
  view: DeviceView | LinkView,
  devices: Readonly<Record<string, DeviceView>> | undefined,
): Choice | undefined {
  if (spec.kind !== 'switch.port.prune-vlan' || key !== 'vlan' || !isLink(view) || !devices) {
    return undefined;
  }
  const choices = spec.params?.[key]?.choices ?? [];
  const onCable = cableVlans(view, devices);
  const fromCable = choices.find((c) => onCable.has(String(c)));
  if (fromCable !== undefined) return fromCable;
  const sw = [view.a.device, view.b.device]
    .map((id) => devices[id])
    .find((d) => d?.kind === 'switch');
  const carried = String(sw?.fields.vlans ?? '')
    .split(',')
    .filter(Boolean);
  return choices.find((c) => carried.includes(String(c)));
}

/** Initial form values: the current state where known, else a sensible or the first choice. */
export function initialParams(
  spec: ActionSpec,
  view: DeviceView | LinkView,
  devices?: Readonly<Record<string, DeviceView>>,
): Record<string, Choice> {
  const out: Record<string, Choice> = {};
  for (const [key, p] of Object.entries(spec.params ?? {})) {
    out[key] =
      currentChoice(spec, key, view) ?? carriedVlan(spec, key, view, devices) ?? p.choices[0] ?? '';
  }
  return out;
}

/**
 * The simulation logs a refused action as `action.rejected` with text
 * `"<kind> on <target>: <why>"` (src/engine/sim.ts). Returns `<why>` for the first rejection of
 * this kind and target at or after `since`, or null.
 */
export function rejectionReason(
  events: readonly SimEvent[],
  kind: string,
  target: string,
  since: number,
): string | null {
  const prefix = `${kind} on ${target}: `;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.t < since) break;
    if (e.code === 'action.rejected' && e.text.startsWith(prefix)) {
      return e.text.slice(prefix.length);
    }
  }
  return null;
}
