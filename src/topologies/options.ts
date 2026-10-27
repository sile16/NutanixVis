/**
 * Typed topology options. Each builder declares its knobs once as `OptionDef`s keyed by a
 * camelCase param name; the same table yields the typed params, the schema `options` array,
 * and the mapping from schema option ids (kebab-case) back to params.
 */
import type { z } from 'zod';
import type { OptionSpecSchema } from './schema';

export type Choice = string | number | boolean;
/** Option values keyed by schema option id (e.g. `{ 'vs1-bond-mode': 'balance-tcp' }`). */
export type OptionValues = Readonly<Record<string, Choice>>;
export type OptionSpecInput = z.input<typeof OptionSpecSchema>;

export interface OptionDef<V extends Choice> {
  readonly id: string;
  readonly label: string;
  readonly choices: readonly V[];
  readonly default: V;
  readonly runtime: boolean;
}

export function option<const V extends Choice>(
  id: string,
  label: string,
  choices: readonly V[],
  def: NoInfer<V>,
  runtime = false,
): OptionDef<V> {
  return { id, label, choices, default: def, runtime };
}

export type OptionDefs = Readonly<Record<string, OptionDef<Choice>>>;
export type ParamsOf<D extends OptionDefs> = {
  -readonly [K in keyof D]: D[K] extends OptionDef<infer V> ? V : never;
};

/** Fill defaults and reject values outside each option's choices. */
export function resolveParams<D extends OptionDefs>(
  defs: D,
  params: Partial<ParamsOf<D>>,
): ParamsOf<D> {
  const out: Record<string, Choice> = {};
  const given = params as Partial<Record<string, Choice>>;
  for (const [key, def] of Object.entries(defs)) {
    const v = given[key] ?? def.default;
    if (!def.choices.includes(v)) {
      throw new Error(`option ${def.id}: ${String(v)} is not one of ${def.choices.join(', ')}`);
    }
    out[key] = v;
  }
  for (const key of Object.keys(given)) {
    if (!(key in defs)) throw new Error(`unknown param ${key}`);
  }
  return out as ParamsOf<D>;
}

/** Map schema-option-id-keyed values to builder params. Unknown ids throw. */
export function paramsFromValues<D extends OptionDefs>(
  defs: D,
  values: OptionValues,
): Partial<ParamsOf<D>> {
  const byId = new Map(Object.entries(defs).map(([key, def]) => [def.id, key]));
  const out: Record<string, Choice> = {};
  for (const [id, v] of Object.entries(values)) {
    const key = byId.get(id);
    if (key === undefined) throw new Error(`unknown option ${id}`);
    out[key] = v;
  }
  return out as Partial<ParamsOf<D>>;
}

/** Inverse of `paramsFromValues`. */
export function valuesFromParams<D extends OptionDefs>(defs: D, params: ParamsOf<D>): OptionValues {
  const p = params as Record<string, Choice>;
  const out: Record<string, Choice> = {};
  for (const [key, def] of Object.entries(defs)) {
    const v = p[key];
    if (v !== undefined) out[def.id] = v;
  }
  return out;
}

/**
 * Schema option specs. `default` carries the value this instance was BUILT with, so the engine
 * can read the current value of options that touch no device field (e.g. multipath policy).
 */
export function optionSpecs<D extends OptionDefs>(defs: D, params: ParamsOf<D>): OptionSpecInput[] {
  const p = params as Record<string, Choice>;
  return Object.entries(defs).map(([key, def]) => ({
    id: def.id,
    label: def.label,
    choices: [...def.choices],
    default: p[key] ?? def.default,
    runtime: def.runtime,
  }));
}

/** Option values for the declared defaults (`resolveParams(defs, {})` in option-id form). */
export function defaultValues(defs: OptionDefs): OptionValues {
  return Object.fromEntries(Object.values(defs).map((d) => [d.id, d.default]));
}
