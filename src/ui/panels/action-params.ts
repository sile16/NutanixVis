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
    case 'seconds':
      return f.pathLossForceShutdownS === null ? 'off' : f.pathLossForceShutdownS;
    case 'enabled':
      if (kind === 'vswitch.set-slb-vlan-aware') return onOff(f.slbVlanAware);
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

/** Initial form values: the current state where known, else the first choice. */
export function initialParams(
  spec: ActionSpec,
  view: DeviceView | LinkView,
): Record<string, Choice> {
  const out: Record<string, Choice> = {};
  for (const [key, p] of Object.entries(spec.params ?? {})) {
    out[key] = currentChoice(spec, key, view) ?? p.choices[0] ?? '';
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
