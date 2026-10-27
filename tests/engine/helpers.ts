/**
 * Test fixtures for the engine: a two-switch fabric with two hosts and a two-port target, plus
 * tiny scriptable devices. Generic, not vendor-specific.
 */
import {
  asEngineContext,
  type BondMode,
  createSimulation,
  type EngineDevice,
  type EngineSimulation,
  type EngineTickContext,
  type EngineTrace,
  type LacpRate,
  type NetworkConfig,
  type NetworkSpec,
  type SimulationOptions,
} from '../../src/engine';
import type { DeviceView, Message, MsgSize, Snapshot, TickContext } from '../../src/engine/types';

export const VERSIONS = { nutanix: 'test', profileId: 'test' } as const;

export interface FabricOptions {
  readonly mode?: BondMode;
  readonly lacpRate?: LacpRate;
  readonly mlag?: boolean;
  readonly vlansA?: readonly number[];
  readonly vlansB?: readonly number[];
  readonly switchMtu?: number;
  readonly endpointMtu?: number;
  readonly config?: Partial<NetworkConfig>;
  /** Extra MACs (VM vNICs) on h1's bond, VLAN 10: ids `h1.vm<i>`. */
  readonly h1Vms?: number;
  readonly slbVlanAware?: boolean;
}

/**
 * sw-a ═ ISL ═ sw-b. Hosts h1/h2: eth0 → sw-a, eth1 → sw-b, bonded as `hN.vs1` (group `vs1`).
 * Each host's CVM has endpoints on VLAN 10 and 20 over the bond and one on the internal bridge.
 * Target `tgt`: p0 → sw-a (`tgt.ep0`, VLAN 10), p1 → sw-b (`tgt.ep1`, VLAN 10; `tgt.ep20`, VLAN 20).
 */
export function fabric(o: FabricOptions = {}): NetworkSpec {
  const mtu = o.endpointMtu ?? 9000;
  const hosts = ['h1', 'h2'];
  const nics = [
    ...hosts.flatMap((h) => [
      { id: `${h}.eth0`, owner: h, mtu: 9000 },
      { id: `${h}.eth1`, owner: h, mtu: 9000 },
    ]),
    { id: 'tgt.p0', owner: 'tgt', mtu: 9000 },
    { id: 'tgt.p1', owner: 'tgt', mtu: 9000 },
  ];
  const sw = (id: string, vlans: readonly number[]) => ({
    id,
    vlans,
    mtu: o.switchMtu ?? 9216,
    ...(o.mlag ? { mlagDomain: 'pair' } : {}),
  });
  const vmEndpoints = Array.from({ length: o.h1Vms ?? 0 }, (_, i) => ({
    id: `h1.vm${i}`,
    owner: 'h1',
    vlan: 10,
    ip: `10.0.10.${100 + i}`,
    mac: `02:00:00:aa:00:${(i + 16).toString(16)}`,
    mtu,
    attach: { kind: 'bond' as const, id: 'h1.vs1' },
  }));
  return {
    nics,
    switches: [sw('sw-a', o.vlansA ?? [10, 20]), sw('sw-b', o.vlansB ?? [10, 20])],
    links: [
      ...hosts.flatMap((h) => [
        { id: `l-${h}-eth0`, a: `${h}.eth0`, b: 'sw-a' },
        { id: `l-${h}-eth1`, a: `${h}.eth1`, b: 'sw-b' },
      ]),
      { id: 'l-tgt-p0', a: 'tgt.p0', b: 'sw-a' },
      { id: 'l-tgt-p1', a: 'tgt.p1', b: 'sw-b' },
      { id: 'l-isl', a: 'sw-a', b: 'sw-b' },
    ],
    bonds: hosts.map((h) => ({
      id: `${h}.vs1`,
      owner: h,
      mode: o.mode ?? 'active-backup',
      uplinks: [`${h}.eth0`, `${h}.eth1`],
      ...(o.slbVlanAware === undefined ? {} : { slbVlanAware: o.slbVlanAware }),
      lacpRate: o.lacpRate ?? 'fast',
      group: 'vs1',
    })),
    bridges: hosts.map((h) => ({ id: `${h}.virbr0`, owner: h })),
    endpoints: [
      ...hosts.flatMap((h, i) => [
        {
          id: `${h}.cvm.ep10`,
          owner: `${h}.cvm`,
          vlan: 10,
          ip: `10.0.10.${11 + i}`,
          mac: `02:00:00:00:0${i + 1}:10`,
          mtu,
          attach: { kind: 'bond' as const, id: `${h}.vs1` },
        },
        {
          id: `${h}.cvm.ep20`,
          owner: `${h}.cvm`,
          vlan: 20,
          ip: `10.0.20.${11 + i}`,
          mac: `02:00:00:00:0${i + 1}:20`,
          mtu,
          attach: { kind: 'bond' as const, id: `${h}.vs1` },
        },
        {
          id: `${h}.cvm.int`,
          owner: `${h}.cvm`,
          vlan: 1,
          ip: '192.168.5.2',
          mac: `02:00:00:00:0${i + 1}:fe`,
          attach: { kind: 'bridge' as const, id: `${h}.virbr0` },
        },
        {
          id: `${h}.hv.int`,
          owner: h,
          vlan: 1,
          ip: '192.168.5.1',
          mac: `02:00:00:00:0${i + 1}:ff`,
          attach: { kind: 'bridge' as const, id: `${h}.virbr0` },
        },
      ]),
      ...vmEndpoints,
      ep('tgt.ep0', 'tgt', 10, '10.0.10.200', '02:00:00:00:99:00', mtu, 'tgt.p0'),
      ep('tgt.ep1', 'tgt', 10, '10.0.10.201', '02:00:00:00:99:01', mtu, 'tgt.p1'),
      ep('tgt.ep20', 'tgt', 20, '10.0.20.201', '02:00:00:00:99:20', mtu, 'tgt.p1'),
    ],
    config: { lacpFastDetectS: 3, lacpSlowDetectS: 90, slbRebalanceIntervalS: 10, ...o.config },
  };
}

function ep(
  id: string,
  owner: string,
  vlan: number,
  ip: string,
  mac: string,
  mtu: number,
  nic: string,
) {
  return { id, owner, vlan, ip, mac, mtu, attach: { kind: 'nic' as const, id: nic } };
}

// ── Scriptable devices ───────────────────────────────────────────────────────

export interface ScriptHooks {
  readonly parentId?: string;
  readonly kind?: string;
  preTick?(ctx: EngineTickContext): void;
  emit?(ctx: EngineTickContext): void;
  onMessage?(msg: Message, ctx: EngineTickContext): void;
  tick?(ctx: EngineTickContext): void;
  postTick?(ctx: EngineTickContext): void;
  onFail?(ctx: EngineTickContext): void;
  onRecover?(ctx: EngineTickContext): void;
  fields?(): DeviceView['fields'];
}

export interface ScriptDevice extends EngineDevice {
  readonly received: Message[];
}

/** A device whose hooks are plain functions; records every message it receives. */
export function device(id: string, hooks: ScriptHooks = {}): ScriptDevice {
  const received: Message[] = [];
  const wrap =
    (fn: ((ctx: EngineTickContext) => void) | undefined) =>
    (ctx: TickContext): void =>
      fn?.(asEngineContext(ctx));
  return {
    id,
    kind: hooks.kind ?? 'test',
    label: id,
    ...(hooks.parentId === undefined ? {} : { parentId: hooks.parentId }),
    received,
    preTick: wrap(hooks.preTick),
    emit: wrap(hooks.emit),
    onMessage(msg, ctx) {
      received.push(msg);
      hooks.onMessage?.(msg, asEngineContext(ctx));
    },
    tick: wrap(hooks.tick),
    postTick: wrap(hooks.postTick),
    onFail: wrap(hooks.onFail),
    onRecover: wrap(hooks.onRecover),
    view: () => ({
      id,
      kind: hooks.kind ?? 'test',
      label: id,
      ...(hooks.parentId === undefined ? {} : { parent: hooks.parentId }),
      status: 'healthy',
      badges: [],
      fields: hooks.fields?.() ?? {},
    }),
  };
}

/** Host / CVM / target devices matching `fabric()` owners (CVMs are children of hosts). */
export function fabricDevices(): ScriptDevice[] {
  return [
    device('h1', { kind: 'host' }),
    device('h1.cvm', { kind: 'cvm', parentId: 'h1' }),
    device('h2', { kind: 'host' }),
    device('h2.cvm', { kind: 'cvm', parentId: 'h2' }),
    device('tgt', { kind: 'target' }),
  ];
}

export interface Probe {
  readonly src: string;
  readonly dst: string;
  readonly size?: MsgSize;
  readonly srcPort?: number;
  readonly dstPort?: number;
  readonly kind?: string;
}

/**
 * A simulation over `network` with a `zz-probe` device that sends `probes()` every tick
 * (from any endpoint; delivery only depends on the network).
 */
export function probeSim(
  network: NetworkSpec,
  probes: readonly Probe[] | ((ctx: EngineTickContext) => readonly Probe[]),
  extra: Partial<SimulationOptions> = {},
): EngineSimulation {
  const sender = device('zz-probe', {
    emit(ctx) {
      for (const p of typeof probes === 'function' ? probes(ctx) : probes) {
        ctx.send({
          kind: p.kind ?? 'probe',
          src: p.src,
          dst: p.dst,
          size: p.size ?? 'small',
          flow: ctx.flow(p.src, p.dst, { srcPort: p.srcPort ?? 1000, dstPort: p.dstPort ?? 4420 }),
          payload: null,
        });
      }
    },
  });
  return createSimulation({
    devices: [...(extra.devices ?? fabricDevices()), sender],
    network,
    profile: null,
    seed: extra.seed ?? 1,
    topologyId: 'test',
    versions: VERSIONS,
    ...(extra.actions ? { actions: extra.actions } : {}),
    ...(extra.traffic ? { traffic: extra.traffic } : {}),
  });
}

export function traces(s: Snapshot): readonly EngineTrace[] {
  return s.traces as readonly EngineTrace[];
}

/** The single trace from `src` to `dst` in the last tick (throws if not exactly one). */
export function traceOf(s: Snapshot, src: string, dst: string): EngineTrace {
  const found = traces(s).filter((t) => t.src === src && t.dst === dst);
  if (found.length !== 1) throw new Error(`expected 1 trace ${src}→${dst}, got ${found.length}`);
  return found[0] as EngineTrace;
}

export function codes(s: Snapshot): string[] {
  return s.events.map((e) => e.code);
}

export function flowsFor(n: number, make: (i: number) => Probe): Probe[] {
  return Array.from({ length: n }, (_, i) => make(i));
}
