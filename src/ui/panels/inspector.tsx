/**
 * Inspector (SPEC §8): the selected device's or cable's view fields, badges and the actions
 * the simulation says apply to it (`availableActions`), including parameterised ones such as
 * bond-mode changes. VMs get the path-usage view (SPEC §6.4b); hosts get bond utilization.
 */
import { ArrowUpRight, Gauge, History, Route } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { actionChoiceLabel } from '../../engine/sim';
import type { ActionSpec, DeviceView, LinkView, Snapshot, ViewField } from '../../engine/types';
import { formatField, humanizeKey } from '../app/format';
import { Button, Select, ShareBar } from '../components/controls';
import { RoleBadge, StatusPill } from '../components/status';
import { type EffectiveDevice, effectiveDevices } from '../diagram/effective-status';
import { useActivityWindow } from '../diagram/hooks';
import { linkUsage } from '../diagram/link-usage';
import { BOND_MODE_LABEL } from '../diagram/nodes/parts';
import {
  ancestorOfKind,
  bondUtilization,
  computePathUsage,
  isBondKind,
} from '../diagram/path-usage';
import { GUI_HIDDEN_CATEGORIES, trafficStyle } from '../diagram/traffic';
import { placementText } from '../diagram/vm-placement';
import { useSim, useSimControls, useSnapshot } from '../store/sim-context';
import { useUi } from '../store/ui-store';
import { currentChoice, initialParams, rejectionReason } from './action-params';
import { deviceName, linkName } from './events-model';
import { isOfferedAction } from './offered-actions';

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="border-t border-border px-3 py-2" data-testid={testId}>
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

function DeviceLink({ id, qualified = false }: { id: string; qualified?: boolean }) {
  const snapshot = useSnapshot();
  const select = useUi((s) => s.select);
  const d = snapshot.devices[id];
  return (
    <button
      type="button"
      className="inline-flex items-center gap-0.5 rounded text-accent-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
      onClick={() => select({ type: 'device', id })}
    >
      {/* Qualified: a NIC with its host ("Node 1 eth2"), an array interface with its controller. */}
      {d ? (qualified ? deviceName(snapshot.devices, id) : d.label) : id}
      <ArrowUpRight size={11} aria-hidden="true" />
    </button>
  );
}

/**
 * Durations and clock readings in view fields (`ioPendingS`, `…TimeoutS`, `…At`, `…Until`,
 * `…Since`) are not shown: time is steps, not seconds, and the engine's internal clock (a tick
 * number) must not read as a time or a duration.
 */
const isTimeField = (k: string, v: ViewField): boolean =>
  (typeof v === 'number' || v === null) && /[a-z](S|At|Until|Since)$/.test(k);

/**
 * Fields shown by their own section instead (`flowPaths`: Storage throughput; `placedBy`,
 * `placedFrom`: the placement line under the title; `ioChain`: the diagram's IO path).
 */
const HIDDEN_FIELDS = new Set(['flowPaths', 'placedBy', 'placedFrom', 'ioChain']);

/** Display names where the key's wording would name a duration. */
const FIELD_LABEL: Readonly<Record<string, string>> = {
  offlineEventsLastHour: 'Recent offline events',
};

function Fields({ fields }: { fields: Readonly<Record<string, ViewField>> }) {
  const entries = Object.entries(fields).filter(
    ([k, v]) =>
      !isTimeField(k, v) &&
      !HIDDEN_FIELDS.has(k) &&
      // With the throughput model running, its latency (µs, incl. queueing) replaces this one.
      !(k === 'ioLatencyMs' && typeof fields.ioLatencyUs === 'number'),
  );
  if (entries.length === 0) return null;
  return (
    <dl
      className="grid grid-cols-[minmax(0,9rem)_1fr] gap-x-3 gap-y-0.5 text-xs"
      data-testid="inspector-fields"
    >
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="truncate text-ink-muted" title={k}>
            {FIELD_LABEL[k] ?? humanizeKey(k)}
          </dt>
          <dd className="truncate font-mono" title={formatField(v)}>
            {k === 'bondMode' && typeof v === 'string' ? (BOND_MODE_LABEL[v] ?? v) : formatField(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ActionForm({
  spec,
  target,
  current,
}: {
  spec: ActionSpec;
  target: string;
  current: DeviceView | LinkView;
}) {
  const { apply } = useSimControls();
  const sim = useSim();
  const snapshot = useSnapshot();
  const manual = useUi((s) => s.manual);
  const params = Object.entries(spec.params ?? {});
  const [values, setValues] = useState(() => initialParams(spec, current, snapshot.devices));
  // Sim time at which this form last applied: show the reason if the engine rejected it.
  const [appliedAt, setAppliedAt] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the log grows per snapshot version
  const rejected = useMemo(
    () =>
      appliedAt === null ? null : rejectionReason(sim.eventLog(), spec.kind, target, appliedAt),
    [appliedAt, sim, spec.kind, target, snapshot.version],
  );
  const submit = (
    <Button
      type="submit"
      size="sm"
      // Beside the choices it matches their height; when they fill the row it wraps to the right.
      className={params.length > 0 ? 'ml-auto h-8 shrink-0' : 'shrink-0'}
      variant={spec.kind === 'fail' ? 'danger' : 'default'}
      data-testid={`action-${spec.kind}`}
    >
      {manual ? 'Queue' : 'Apply'}
    </Button>
  );
  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-border bg-panel-2 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        // Queued actions apply at the start of the next tick.
        setAppliedAt(sim.getSnapshot().simTime + 1);
        apply(
          params.length ? { kind: spec.kind, target, params: values } : { kind: spec.kind, target },
        );
      }}
    >
      {/* Title and description take the full width; the choices and the button go below them. */}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-snug">{spec.label}</div>
          {spec.description ? (
            <p className="mt-0.5 text-[11px] leading-snug text-ink-muted">{spec.description}</p>
          ) : null}
        </div>
        {params.length === 0 ? submit : null}
      </div>
      {params.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          {params.map(([key, p]) => (
            <div key={key} className="min-w-[9rem] flex-1 [&_select]:w-full">
              <Select
                label={p.label}
                value={String(values[key] ?? '')}
                onChange={(e) => {
                  const choice = p.choices.find((c) => String(c) === e.target.value);
                  if (choice !== undefined) setValues((v) => ({ ...v, [key]: choice }));
                }}
              >
                {p.choices.map((c) => (
                  <option key={String(c)} value={String(c)}>
                    {key === 'mode'
                      ? (BOND_MODE_LABEL[String(c)] ?? String(c))
                      : actionChoiceLabel(key, p.choices, c)}
                    {currentChoice(spec, key, current) === c ? ' (current)' : ''}
                  </option>
                ))}
              </Select>
            </div>
          ))}
          {submit}
        </div>
      ) : null}
      {rejected ? (
        <p
          role="status"
          className="text-[11px] text-status-failed"
          data-testid={`action-rejected-${spec.kind}`}
        >
          Not applied: {rejected}
        </p>
      ) : null}
    </form>
  );
}

function Actions({ target, view }: { target: string; view: DeviceView | LinkView }) {
  const sim = useSim();
  const snapshot = useSnapshot();
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-query when the snapshot changes
  const specs = useMemo(
    () => sim.availableActions(target).filter((s) => isOfferedAction(s, view)),
    [sim, target, view, snapshot.version],
  );
  return (
    <Section title="Actions" testId="inspector-actions">
      {specs.length === 0 ? (
        <p className="text-xs text-ink-muted">
          No actions apply to this {('kind' in view && view.kind) || 'cable'}.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {specs.map((s) => (
            <ActionForm key={`${target}:${s.kind}`} spec={s} target={target} current={view} />
          ))}
        </div>
      )}
    </Section>
  );
}

interface FlowPathView {
  readonly id: string;
  readonly gbps: number;
  readonly latencyUs: number;
  readonly islPct: number;
  readonly routes: readonly { readonly pct: number; readonly out: string; readonly back: string }[];
}

function parseFlowPaths(v: ViewField | undefined): FlowPathView[] {
  if (typeof v !== 'string') return [];
  try {
    const x: unknown = JSON.parse(v);
    return Array.isArray(x) ? (x as FlowPathView[]) : [];
  } catch {
    return [];
  }
}

/** An NVMe path id (`<cvm-interface>~<fa-interface>`) as `CVM-IP A → CT0 eth10 (VLAN 10)`. */
function nvmePathName(snapshot: Snapshot, id: string): string {
  const label = (x: string) => snapshot.devices[x]?.label ?? x;
  const [local = '', remote = ''] = id.split('~');
  const port = snapshot.devices[remote]?.parent;
  const ct = port ? snapshot.devices[port]?.parent : undefined;
  return `${label(local)} → ${ct ? `${label(ct)} ` : ''}${port ? label(port) : label(remote)} (${label(remote)})`;
}

const jsonRecord = (v: ViewField | undefined): Record<string, unknown> => {
  if (typeof v !== 'string') return {};
  try {
    const x: unknown = JSON.parse(v);
    return x !== null && typeof x === 'object' && !Array.isArray(x)
      ? (x as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/** The CVM fields that `CvmPathsSection` shows as one row per path. */
const CVM_PATH_FIELDS = new Set([
  'nvmePaths',
  'nvmePathLatencyMs',
  'nvmePathIoShare',
  'nvmePathsInaccessible',
]);

/**
 * T1: one row per NVMe path of the CVM, with its state (`live`, `lost`, `removed`, or ANA
 * Inaccessible while its controller drains), its share of the CVM's IO over the last 30 s and
 * its latest IO latency (docs/view-fields.md `cvm`).
 */
function CvmPathsSection({ cvm }: { cvm: DeviceView }) {
  const snapshot = useSnapshot();
  const states = jsonRecord(cvm.fields.nvmePaths);
  const ids = Object.keys(states);
  if (ids.length === 0) return null;
  const latency = jsonRecord(cvm.fields.nvmePathLatencyMs);
  const share = jsonRecord(cvm.fields.nvmePathIoShare);
  let inaccessible: unknown = [];
  try {
    inaccessible = JSON.parse(String(cvm.fields.nvmePathsInaccessible ?? '[]'));
  } catch {
    inaccessible = [];
  }
  const ana = new Set(Array.isArray(inaccessible) ? inaccessible.map(String) : []);
  const tone = (st: string) =>
    st === 'live'
      ? 'text-status-healthy'
      : st === 'inaccessible'
        ? 'text-status-stalled'
        : 'text-status-failed';
  return (
    <Section title="NVMe paths" testId="cvm-paths">
      <ul className="space-y-0.5 text-[11px]">
        {ids.map((id) => {
          const st = states[id] === 'live' && ana.has(id) ? 'inaccessible' : String(states[id]);
          const pct = share[id];
          const ms = latency[id];
          return (
            <li key={id} className="flex gap-2" data-testid="cvm-path" data-state={st}>
              <span className="truncate" title={id}>
                {nvmePathName(snapshot, id)}
              </span>
              <span className="ml-auto shrink-0 font-mono">
                <span className={tone(st)}>{st === 'inaccessible' ? 'ANA inaccessible' : st}</span>
                {typeof pct === 'number' ? ` · ${pct}%` : ''}
                {/* A lost path's last latency is stale: show it only while the path is up. */}
                {typeof ms === 'number' && st !== 'lost' && st !== 'removed'
                  ? ` · ${ms < 10 ? ms.toFixed(2) : Math.round(ms)} ms`
                  : ''}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-1 text-[10px] text-ink-muted">
        state · share of this CVM's IO · latest IO latency
      </div>
    </Section>
  );
}

/**
 * Throughput model (T1): the VM's rate, read/write split and latency, and per NVMe path how much
 * it carries, its latency and the links it crosses out and back (docs/research/link-congestion.md).
 * The queue-depth selector keeps outstanding IO equal per path, so a slower path carries less.
 */
function ThroughputSection({ vm }: { vm: DeviceView }) {
  const snapshot = useSnapshot();
  const f = vm.fields;
  if (typeof f.throughputGbps !== 'number') return null;
  const paths = parseFlowPaths(f.flowPaths);
  const pathName = (id: string) => nvmePathName(snapshot, id);
  const offered = f.offeredLoad === 'line-rate' ? 'line rate' : `${String(f.offeredLoad)} Gb/s`;
  return (
    <Section title="Storage throughput" testId="vm-throughput">
      <div className="text-xs" data-testid="vm-throughput-summary">
        <span className="font-mono">{f.throughputGbps} Gb/s</span> of {offered} offered ·{' '}
        {String(f.readPct)}% read ({String(f.readGbps)} Gb/s) · {100 - Number(f.readPct)}% write (
        {String(f.writeGbps)} Gb/s) ·{' '}
        {typeof f.ioLatencyUs === 'number' ? (
          <>
            <span className="font-mono">{f.ioLatencyUs} µs</span> per IO
          </>
        ) : (
          <span data-testid="vm-throughput-none">
            {f.state === 'paused' ? 'paused' : 'no IO completing'}
          </span>
        )}
      </div>
      <ul className="mt-1 space-y-1 text-[11px]" data-testid="vm-throughput-paths">
        {paths.map((p) => (
          <li key={p.id} data-testid="vm-throughput-path" data-isl={p.islPct}>
            <div className="flex gap-2">
              <span className="truncate" title={p.id}>
                {pathName(p.id)}
              </span>
              <span className="ml-auto shrink-0 font-mono">
                {p.gbps} Gb/s · {p.latencyUs} µs{p.islPct > 0 ? ` · ISL ${p.islPct}%` : ''}
              </span>
            </div>
            {p.routes.map((r) => (
              <div key={`${r.out}|${r.back}`} className="pl-2 font-mono text-ink-muted">
                {p.routes.length > 1 ? `${r.pct}% ` : ''}out {r.out}
                {r.back ? (
                  <>
                    <br />
                    {p.routes.length > 1 ? '    ' : ''}back {r.back}
                  </>
                ) : null}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Path-usage text for a VM that runs no IO (`vm.ts` lifecycle states), or null if it runs. */
const IDLE_STATE: Readonly<Record<string, string>> = {
  off: 'Powered off',
  paused: 'Paused',
  crashed: 'Crashed',
  restarting: 'Restarting',
};

const isServing = (cvm: DeviceView | undefined): boolean =>
  !!cvm &&
  cvm.fields.down !== true &&
  cvm.status !== 'failed' &&
  cvm.status !== 'offline' &&
  (cvm.fields.stargate === 'up' || cvm.fields.stargate === 'unhealthy');

/** `CVM 1 is down` / `CVM 1's Stargate is hung`: why a CVM serves nothing. */
function notServingText(cvm: DeviceView): string {
  if (cvm.fields.down === true || cvm.status === 'failed' || cvm.status === 'offline') {
    return `${cvm.label} is down`;
  }
  const sg = cvm.fields.stargate;
  return `${cvm.label}'s Stargate is ${typeof sg === 'string' ? sg : 'not serving'}`;
}

function PathUsageSection({ vm }: { vm: DeviceView }) {
  const vmId = vm.id;
  const snapshot = useSnapshot();
  // Same rolling window as the diagram, so shares don't jump with per-tick round-robin.
  const activityTicks = useUi((s) => s.activityTicks);
  const win = useActivityWindow(activityTicks);
  const usage = computePathUsage(win.snapshot, vmId, win.vmPaths.get(vmId));
  const windowLabel = 'recent activity';
  // A VM that is not running sends no IO: show 0, not its host's traffic (the CVM's own).
  const state = typeof vm.fields.state === 'string' ? vm.fields.state : '';
  const idle = vm.status === 'failed' ? 'Failed' : IDLE_STATE[state];
  if (idle) {
    return (
      <Section title="Path usage" testId="path-usage">
        <p className="text-xs text-ink-muted" data-testid="path-usage-idle">
          {idle}: this VM sends no storage IO, so no uplink or array port carries any of its traffic
          (0%).
        </p>
      </Section>
    );
  }
  if (!usage) return null;
  const devices = snapshot.devices;
  const ownCvmId = usage.hostId ? `${usage.hostId}.cvm` : undefined;
  const ownCvm = ownCvmId ? devices[ownCvmId] : undefined;
  // HCI only (no external array): a VM whose vDisks its own host's serving CVM owns has its IO
  // on virbr0, with no network path; the host's storage traffic is the closest view.
  const hasArray = Object.values(devices).some((d) => d.kind === 'fa-array');
  const local =
    usage.scope === 'host' && !hasArray && usage.cvmId === ownCvmId && isServing(ownCvm);
  const owner = (
    <div className="mb-2 flex items-center gap-1 text-xs">
      <Route size={13} className="text-accent-ink" aria-hidden="true" />
      Owning CVM:{' '}
      {usage.cvmId ? (
        <DeviceLink id={usage.cvmId} />
      ) : (
        <span className="text-ink-muted">none (compute-only)</span>
      )}
    </div>
  );
  // Its own CVM is down or hung and none of its IO has reached another CVM yet: its host's
  // traffic (management, the CVM's own) is not this VM's, so say so instead.
  if (usage.scope === 'host' && ownCvm && !isServing(ownCvm)) {
    return (
      <Section title="Path usage" testId="path-usage">
        {owner}
        <p className="text-xs text-ink-muted" data-testid="path-usage-none">
          {notServingText(ownCvm)}, and none of this VM's storage IO crossed the network in{' '}
          {windowLabel}: no uplink or array port to show.
        </p>
      </Section>
    );
  }
  const toArray = usage.targets.every((t) =>
    ancestorOfKind(win.snapshot.devices, t.deviceId, 'fa-array'),
  );
  const targetsTitle = toArray
    ? 'Array ports'
    : usage.scope === 'vm'
      ? "Serving CVM's node ports"
      : 'Peer-node ports (replication and remote IO of this host)';
  return (
    <Section title="Path usage" testId="path-usage">
      {owner}
      {local ? (
        <p className="mb-2 text-xs" data-testid="path-usage-local">
          Served by the local CVM over virbr0: this VM's IO has no network path. Below: all storage
          traffic of its host.
        </p>
      ) : null}
      <p className="mb-1 text-[11px] text-ink-muted">
        Uplinks ({usage.traceCount} storage messages, {windowLabel})
      </p>
      <div className="mb-2 flex flex-col gap-1">
        {usage.uplinks.length ? (
          usage.uplinks.map((s) => (
            <ShareBar
              key={s.linkId}
              label={s.label}
              share={s.share}
              detail={`${s.count} messages`}
              down={s.status === 'down'}
            />
          ))
        ) : (
          <p className="text-xs text-ink-muted">No storage traffic in {windowLabel}.</p>
        )}
      </div>
      {usage.targets.length ? (
        <>
          <p className="mb-1 text-[11px] text-ink-muted" data-testid="path-usage-targets-title">
            {targetsTitle}
          </p>
          <div className="flex flex-col gap-1">
            {usage.targets.map((s) => (
              <ShareBar
                key={s.linkId}
                label={s.label}
                share={s.share}
                tone="muted"
                detail={`${s.count} messages`}
              />
            ))}
          </div>
        </>
      ) : null}
      <p className="mt-2 text-[10px] text-ink-muted" data-testid="path-usage-scope">
        {usage.scope === 'vm'
          ? "This VM's own paths (its ioPaths / ioUplinks). Highlighted on the diagram."
          : "All storage traffic of this VM's host. Highlighted on the diagram."}
      </p>
    </Section>
  );
}

function BondSection({ hostId }: { hostId: string }) {
  const bondUtilHost = useUi((s) => s.bondUtilHost);
  const setBondUtilHost = useUi((s) => s.setBondUtilHost);
  const activityTicks = useUi((s) => s.activityTicks);
  const win = useActivityWindow(activityTicks);
  const bonds = bondUtilization(win.snapshot, hostId);
  if (bonds.length === 0) return null;
  const on = bondUtilHost === hostId;
  return (
    <Section title="Bond member share of traffic" testId="bond-util">
      <Button
        size="sm"
        aria-pressed={on}
        onClick={() => setBondUtilHost(on ? null : hostId)}
        className="mb-2"
        data-testid="toggle-bond-util"
      >
        <Gauge size={13} aria-hidden="true" />
        {on ? 'Hide on diagram' : 'Show on diagram'}
      </Button>
      {bonds.map((b) => (
        <div key={b.vswitchId} className="mb-2">
          <div className="mb-1 text-xs">
            <span className="font-semibold">{b.label}</span>{' '}
            <span className="text-ink-muted">· {BOND_MODE_LABEL[b.bondMode] ?? b.bondMode}</span>
          </div>
          <div className="flex flex-col gap-1">
            {b.members.map((m) => (
              <div key={m.nicId}>
                <ShareBar
                  label={m.label}
                  share={m.share}
                  down={m.status === 'down'}
                  detail={
                    b.basis === 'throughput'
                      ? `${m.label}: ${Math.round(m.share * 100)}% of ${b.label} traffic now`
                      : Object.entries(m.byCategory)
                          .map(([c, n]) => `${trafficStyle(c).label}: ${n}`)
                          .join(', ')
                  }
                />
                {b.basis === 'throughput' && m.capacityGbps ? (
                  <div
                    className="pl-[7rem] font-mono text-[11px] text-ink-muted"
                    data-testid="bond-member-line-rate"
                  >
                    of {m.capacityGbps} Gb line rate: in {Math.round(m.inGbps ?? 0)} Gb (
                    {Math.round((100 * (m.inGbps ?? 0)) / m.capacityGbps)}%) · out{' '}
                    {Math.round(m.outGbps ?? 0)} Gb (
                    {Math.round((100 * (m.outGbps ?? 0)) / m.capacityGbps)}%)
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-ink-muted">
            {b.basis === 'throughput'
              ? 'Share of storage Gb/s carried now (throughput model). Line rate is per direction.'
              : 'Share of sampled messages of every kind over recent activity.'}
          </p>
        </div>
      ))}
    </Section>
  );
}

/** Where a VM runs now versus its topology host (AHV HA restarts and live migrations move it). */
function VmPlacement({ vm }: { vm: DeviceView }) {
  const snapshot = useSnapshot();
  const host = vm.fields.host;
  const origin = vm.parent;
  if (typeof host === 'string' && host !== origin) {
    const prev = vm.fields.placedFrom;
    const from = typeof prev === 'string' && prev !== host ? prev : origin;
    return (
      <div className="mt-1 text-xs text-ink-muted" data-testid="vm-placement">
        Runs on <DeviceLink id={host} />
        {from && from !== host ? (
          <>
            {' '}
            · <History size={11} className="inline" aria-hidden="true" />{' '}
            {placementText(vm.fields.placedBy)} <DeviceLink id={from} />
            <span className="sr-only"> (previous host)</span>
          </>
        ) : null}
      </div>
    );
  }
  if (host === null && origin) {
    return (
      <div className="mt-1 text-xs text-ink-muted" data-testid="vm-placement">
        Not running · topology host <DeviceLink id={origin} />
      </div>
    );
  }
  return origin && snapshot.devices[origin] ? (
    <div className="mt-1 text-xs text-ink-muted" data-testid="vm-placement">
      Runs on <DeviceLink id={origin} />
    </div>
  ) : null;
}

function DeviceInspector({ device: raw }: { device: DeviceView }) {
  const snapshot = useSnapshot();
  const shown = useMemo(() => effectiveDevices(snapshot.devices), [snapshot.devices]);
  const device: EffectiveDevice = shown[raw.id] ?? raw;
  const children = Object.values(snapshot.devices).filter((d) => d.parent === device.id);
  const hostField = device.kind === 'vm' ? device.fields.host : undefined;
  const host =
    typeof hostField === 'string'
      ? snapshot.devices[hostField]
      : ancestorOfKind(snapshot.devices, device.id, 'ahv-host');
  const showBond = device.kind === 'ahv-host' || isBondKind(device.kind);
  return (
    <div data-testid="inspector-device">
      <header className="px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-base font-semibold" data-testid="inspector-title">
            {device.label}
          </h2>
          <StatusPill status={device.status} />
        </div>
        {device.downReason ? (
          <div className="text-[11px] text-status-failed" data-testid="inspector-down-reason">
            {device.downReason}
          </div>
        ) : null}
        <div className="font-mono text-[11px] text-ink-muted">
          {device.kind} · {device.id}
        </div>
        {device.badges.length ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {device.badges.map((b) => (
              <RoleBadge key={b} badge={b} />
            ))}
          </div>
        ) : null}
        {device.kind === 'vm' ? (
          <VmPlacement vm={raw} />
        ) : device.parent ? (
          <div className="mt-1 text-xs text-ink-muted">
            In <DeviceLink id={device.parent} />
          </div>
        ) : null}
      </header>
      <Section title="State">
        <Fields
          fields={
            device.kind === 'cvm' && typeof device.fields.nvmePaths === 'string'
              ? Object.fromEntries(
                  Object.entries(device.fields).filter(([k]) => !CVM_PATH_FIELDS.has(k)),
                )
              : device.fields
          }
        />
      </Section>
      {device.kind === 'cvm' ? <CvmPathsSection cvm={device} /> : null}
      {device.kind === 'vm' ? <ThroughputSection vm={device} /> : null}
      {device.kind === 'vm' ? <PathUsageSection vm={device} /> : null}
      {showBond && host ? <BondSection hostId={host.id} /> : null}
      <Actions target={device.id} view={device} />
      {children.length ? (
        <Section title="Contains">
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {children.map((c) => (
              <li key={c.id}>
                <DeviceLink id={c.id} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

/** Throughput model (T1): Gb/s, line rate and queueing delay per direction of a cable. */
function LinkThroughput({ linkId }: { linkId: string }) {
  const snapshot = useSnapshot();
  const dirs = linkUsage(snapshot)?.get(linkId);
  if (!dirs || dirs.length === 0) return null;
  const label = (id: string) => snapshot.devices[id]?.label ?? id;
  return (
    <Section title="Throughput (storage IO)" testId="link-throughput">
      <ul className="space-y-0.5 text-xs">
        {dirs.map((d) => (
          <li key={d.from} className="flex gap-2" data-testid="link-throughput-dir">
            <span className="truncate">
              {label(d.from)} → {label(d.to)}
            </span>
            <span className="ml-auto shrink-0 font-mono">
              {d.gbps} / {d.capacityGbps} Gb/s ({Math.round((100 * d.gbps) / d.capacityGbps)}%)
              {d.delayUs > 0 ? ` · queue +${Math.round(d.delayUs)} µs` : ''}
              {d.dropGbps > 0 ? ` · drops ${d.dropGbps} Gb/s` : ''}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function LinkInspector({ link }: { link: LinkView }) {
  const snapshot = useSnapshot();
  // Utilization over the same activity window as the diagram glow.
  const activityTicks = useUi((s) => s.activityTicks);
  const win = useActivityWindow(activityTicks);
  const util = Object.fromEntries(
    Object.entries(win.snapshot.links[link.id]?.util ?? link.util).filter(
      ([c]) => !GUI_HIDDEN_CATEGORIES.has(c),
    ),
  );
  const total = Object.values(util).reduce((s, v) => s + v, 0);
  const windowLabel = 'recent activity';
  return (
    <div data-testid="inspector-link">
      <header className="px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-base font-semibold" data-testid="inspector-title">
            {linkName(snapshot.devices, snapshot.links, link.id) ?? link.id}
          </h2>
          <StatusPill status={link.status === 'up' ? 'healthy' : 'failed'} />
        </div>
        <div className="font-mono text-[11px] text-ink-muted">cable · {link.id}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
          <DeviceLink id={link.a.device} qualified />{' '}
          <span className="font-mono text-ink-muted">{link.a.port}</span>
          <span aria-hidden="true">↔</span>
          <DeviceLink id={link.b.device} qualified />{' '}
          <span className="font-mono text-ink-muted">{link.b.port}</span>
        </div>
      </header>
      <Section title="State">
        <Fields
          fields={{
            status: link.status,
            mtu: link.mtu,
            latencyMs: link.latencyMs,
            lossPct: link.lossPct ?? 0,
          }}
        />
      </Section>
      <LinkThroughput linkId={link.id} />
      <Section title={`Utilization (${windowLabel})`}>
        {total === 0 ? (
          <p className="text-xs text-ink-muted">No delivered traffic.</p>
        ) : (
          <div className="flex flex-col gap-1" data-testid="link-util">
            {Object.entries(util).map(([c, n]) => (
              <ShareBar
                key={c}
                label={trafficStyle(c).label}
                share={n / total}
                detail={`${n} messages`}
              />
            ))}
          </div>
        )}
      </Section>
      <Actions target={link.id} view={link} />
    </div>
  );
}

function NoSelection({ snapshot }: { snapshot: Snapshot }) {
  const select = useUi((s) => s.select);
  const devices = Object.values(snapshot.devices).sort((a, b) => a.id.localeCompare(b.id));
  return (
    <div className="px-3 py-2" data-testid="inspector-empty">
      <Select
        label="Jump to device"
        value=""
        onChange={(e) => e.target.value && select({ type: 'device', id: e.target.value })}
        data-testid="device-picker"
      >
        <option value="">Choose…</option>
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            {d.id} — {d.label}
          </option>
        ))}
      </Select>
      <h3 className="mt-4 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        Cluster
      </h3>
      <Fields
        fields={Object.fromEntries(
          Object.entries(snapshot.derived).flatMap(([k, v]) =>
            v !== null && typeof v === 'object'
              ? Object.entries(v).map(([k2, v2]) => [`${k}.${k2}`, v2])
              : [[k, v]],
          ),
        )}
      />
    </div>
  );
}

export function Inspector() {
  const snapshot = useSnapshot();
  const selection = useUi((s) => s.selection);
  if (!selection) return <NoSelection snapshot={snapshot} />;
  if (selection.type === 'device') {
    const d = snapshot.devices[selection.id];
    return d ? <DeviceInspector device={d} /> : <NoSelection snapshot={snapshot} />;
  }
  const l = snapshot.links[selection.id];
  return l ? <LinkInspector link={l} /> : <NoSelection snapshot={snapshot} />;
}
