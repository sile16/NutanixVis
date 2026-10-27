/**
 * A mock `Simulation` (stream B) that cycles through hand-written fixture frames so the UI can be
 * built and e2e-tested before the engine exists. It honours the facade contract (subscribe,
 * frozen snapshots, queued actions applied at the start of the next tick) but models nothing:
 * actions only overlay simple effects (fail → device failed and its cables down, etc.).
 */
import type {
  ActionRequest,
  ActionSpec,
  DeviceId,
  DeviceStatus,
  DeviceView,
  LinkId,
  LinkView,
  SimEvent,
  Simulation,
  Snapshot,
  Trace,
  VersionSelection,
  ViewField,
} from '../engine/types';

export interface MockFrame {
  readonly snapshot: Snapshot;
  /** How many ticks the frame is shown before the next one. */
  readonly holdTicks: number;
}

export interface MockSimulationOptions {
  readonly frames: readonly MockFrame[];
  readonly versions?: VersionSelection;
}

const BOND_MODES = ['active-backup', 'balance-slb', 'balance-tcp', 'no-bond'] as const;

const FAILABLE = new Set([
  'switch',
  'ahv-host',
  'cvm',
  'vm',
  'nic',
  'fa-controller',
  'fa-array',
  'fa-interface',
  'disk',
]);

function isLinkView(t: DeviceView | LinkView): t is LinkView {
  return 'a' in t && 'b' in t;
}

export const mockActions: readonly ActionSpec[] = [
  {
    kind: 'fail',
    label: 'Fail',
    description: 'Inject a hard failure (power loss / crash).',
    appliesTo: (t) => !isLinkView(t) && FAILABLE.has(t.kind) && t.status !== 'failed',
  },
  {
    kind: 'recover',
    label: 'Recover',
    description: 'Undo an injected failure.',
    appliesTo: (t) => !isLinkView(t) && (t.status === 'failed' || t.status === 'offline'),
  },
  {
    kind: 'link-down',
    label: 'Cable down',
    description: 'Pull this cable.',
    appliesTo: (t) => isLinkView(t) && t.status === 'up',
  },
  {
    kind: 'link-up',
    label: 'Cable up',
    description: 'Reconnect this cable.',
    appliesTo: (t) => isLinkView(t) && t.status === 'down',
  },
  {
    kind: 'fa.controller.failover',
    label: 'Planned controller failover',
    description: 'Hand the primary role to the peer controller.',
    appliesTo: (t) =>
      !isLinkView(t) && t.kind === 'fa-controller' && t.badges.includes('fa-primary'),
  },
  {
    kind: 'vswitch.set-bond-mode',
    label: 'Set bond mode',
    description: 'Applies to this virtual switch on every host (no mixed bond modes).',
    appliesTo: (t) => !isLinkView(t) && t.kind === 'vswitch',
    params: { mode: { label: 'Bond mode', choices: BOND_MODES } },
  },
  {
    kind: 'vswitch.set-lacp-rate',
    label: 'Set LACP rate',
    appliesTo: (t) => !isLinkView(t) && t.kind === 'vswitch' && t.fields.bondMode === 'balance-tcp',
    params: { rate: { label: 'LACP rate', choices: ['fast', 'slow'] } },
  },
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export function createMockSimulation(options: MockSimulationOptions): Simulation {
  const frames = options.frames;
  if (frames.length === 0) throw new Error('mock simulation needs at least one frame');

  let simTime = frames[0]?.snapshot.simTime ?? 0;
  let frameIndex = 0;
  let ticksInFrame = 0;
  let version = 0;
  let seq = 0;
  const log: SimEvent[] = [];
  let tickEvents: SimEvent[] = [];
  const queue: ActionRequest[] = [];
  const listeners = new Set<() => void>();

  const failed = new Set<DeviceId>();
  const downLinks = new Set<LinkId>();
  const fieldPatches = new Map<DeviceId, Record<string, ViewField>>();
  let primaryOverride: DeviceId | null = null;

  const frame = (): Snapshot => {
    const f = frames[frameIndex] ?? frames[0];
    if (!f) throw new Error('unreachable');
    return f.snapshot;
  };

  const emit = (e: Omit<SimEvent, 'seq' | 't'>): string => {
    seq += 1;
    const ev: SimEvent = { ...e, seq, t: simTime };
    log.push(ev);
    tickEvents.push(ev);
    return `e${seq}`;
  };

  /** Re-emit a frame's authored events with log-wide seq numbers and remapped cause ids. */
  const emitFrameEvents = (events: readonly SimEvent[]) => {
    const base = seq;
    for (const e of events) {
      // Authored frame events are numbered 1..k; keep their relative numbering.
      seq = Math.max(seq, base + e.seq - 1);
      emit({
        severity: e.severity,
        ...(e.deviceId === undefined ? {} : { deviceId: e.deviceId }),
        ...(e.confidence === undefined ? {} : { confidence: e.confidence }),
        code: e.code,
        text: e.text,
        cite: e.cite,
        causeIds: e.causeIds.map((c) => {
          const m = /^e(\d+)$/.exec(c);
          return m ? `e${base + Number(m[1])}` : c;
        }),
      });
    }
  };

  const failedOrAncestorFailed = (devices: Snapshot['devices'], id: DeviceId): boolean => {
    let cur: DeviceView | undefined = devices[id];
    while (cur) {
      if (failed.has(cur.id)) return true;
      cur = cur.parent ? devices[cur.parent] : undefined;
    }
    return false;
  };

  const build = (): Snapshot => {
    const base = frame();
    const devices: Record<DeviceId, DeviceView> = {};
    for (const d of Object.values(base.devices)) {
      let status: DeviceStatus = d.status;
      if (failed.has(d.id)) status = 'failed';
      else if (failedOrAncestorFailed(base.devices, d.id)) status = 'offline';
      let badges = d.badges;
      if (primaryOverride && d.kind === 'fa-controller') {
        badges =
          d.id === primaryOverride ? ['fa-primary'] : d.badges.filter((b) => b !== 'fa-primary');
      }
      const patch = fieldPatches.get(d.id);
      devices[d.id] = {
        ...d,
        status,
        badges,
        fields: patch ? { ...d.fields, ...patch } : d.fields,
      };
    }
    const links: Record<LinkId, LinkView> = {};
    for (const l of Object.values(base.links)) {
      const down =
        downLinks.has(l.id) ||
        failedOrAncestorFailed(base.devices, l.a.device) ||
        failedOrAncestorFailed(base.devices, l.b.device);
      links[l.id] = down ? { ...l, status: 'down', util: {} } : l;
    }
    const traces: Trace[] = base.traces.map((t) => {
      if (t.result === 'dropped') return t;
      const idx = t.links.findIndex((id) => links[id]?.status === 'down');
      if (idx < 0) return t;
      const at = t.links[idx] ?? '';
      return {
        ...t,
        links: t.links.slice(0, idx + 1),
        result: 'dropped',
        dropAt: at,
        reason: 'link-down',
      };
    });
    const hold = frames[frameIndex]?.holdTicks ?? 1;
    version += 1;
    return deepFreeze({
      ...base,
      version,
      simTime,
      versions: options.versions ?? base.versions,
      devices,
      links,
      traces,
      events: tickEvents,
      nextTimerAt: frames.length > 1 ? simTime + (hold - ticksInFrame) : null,
    });
  };

  const applyQueued = () => {
    const base = frame();
    for (const a of queue.splice(0)) {
      const device = base.devices[a.target];
      const label = device?.label ?? base.links[a.target]?.id ?? a.target;
      switch (a.kind) {
        case 'fail':
          failed.add(a.target);
          break;
        case 'recover':
          failed.delete(a.target);
          break;
        case 'link-down':
          downLinks.add(a.target);
          break;
        case 'link-up':
          downLinks.delete(a.target);
          break;
        case 'fa.controller.failover': {
          const peer = Object.values(base.devices).find(
            (d) => d.kind === 'fa-controller' && d.id !== a.target && d.parent === device?.parent,
          );
          if (peer) primaryOverride = peer.id;
          break;
        }
        case 'vswitch.set-bond-mode':
        case 'vswitch.set-lacp-rate': {
          const key = a.kind === 'vswitch.set-bond-mode' ? 'bondMode' : 'lacpRate';
          const value = a.params?.mode ?? a.params?.rate ?? null;
          for (const d of Object.values(base.devices)) {
            if (d.kind === 'vswitch' && d.label === device?.label) {
              fieldPatches.set(d.id, { ...fieldPatches.get(d.id), [key]: value });
            }
          }
          break;
        }
        default:
          break;
      }
      emit({
        severity: 'info',
        ...(device ? { deviceId: a.target } : {}),
        code: `action.${a.kind}`,
        text: `Action applied: ${a.kind} on ${label} (fixture simulation: cosmetic effect only).`,
        causeIds: [],
        cite: [],
        confidence: 'assumption',
      });
    }
  };

  const tickOnce = () => {
    applyQueued();
    simTime += 1;
    ticksInFrame += 1;
    const hold = frames[frameIndex]?.holdTicks ?? 1;
    if (frames.length > 1 && ticksInFrame >= hold) {
      frameIndex = (frameIndex + 1) % frames.length;
      ticksInFrame = 0;
      if (frameIndex === 0) {
        emit({
          severity: 'info',
          code: 'fixture.loop',
          text: 'Fixture loop restarted: steady state restored.',
          causeIds: [],
          cite: [],
        });
      }
      emitFrameEvents(frame().events);
    }
  };

  let snapshot = build();
  const notify = () => {
    for (const l of [...listeners]) l();
  };

  const sim: Simulation = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    applyAction(action) {
      queue.push(action);
      notify();
    },
    tick(n = 1) {
      tickEvents = [];
      for (let i = 0; i < Math.max(1, Math.floor(n)); i++) tickOnce();
      snapshot = build();
      notify();
      return snapshot;
    },
    runUntilNextTimer(maxTicks = 3600) {
      const next = snapshot.nextTimerAt;
      const n = next === null ? 1 : Math.min(Math.max(1, next - simTime), maxTicks);
      return sim.tick(n);
    },
    availableActions(target) {
      const view: DeviceView | LinkView | undefined =
        snapshot.devices[target] ?? snapshot.links[target];
      if (!view) return [];
      return mockActions.filter((a) => a.appliesTo(view));
    },
    eventLog: () => log,
  };
  return sim;
}
