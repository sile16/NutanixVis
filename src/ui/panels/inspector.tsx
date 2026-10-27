/**
 * Inspector (SPEC §8): the selected device's or cable's view fields, badges and the actions
 * the simulation says apply to it (`availableActions`), including parameterised ones such as
 * bond-mode changes. VMs get the path-usage view (SPEC §6.4b); hosts get bond utilization.
 */
import { ArrowUpRight, Gauge, Route } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import type { ActionSpec, DeviceView, LinkView, Snapshot, ViewField } from '../../engine/types';
import { humanizeKey } from '../app/format';
import { Button, Select, ShareBar } from '../components/controls';
import { RoleBadge, StatusPill } from '../components/status';
import { useActivityWindow } from '../diagram/hooks';
import { BOND_MODE_LABEL } from '../diagram/nodes/parts';
import { ancestorOfKind, bondUtilization, computePathUsage } from '../diagram/path-usage';
import { trafficStyle } from '../diagram/traffic';
import { useSim, useSimControls, useSnapshot } from '../store/sim-context';
import { useUi } from '../store/ui-store';

function formatField(v: ViewField): string {
  if (v === null) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

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

function DeviceLink({ id }: { id: string }) {
  const snapshot = useSnapshot();
  const select = useUi((s) => s.select);
  const d = snapshot.devices[id];
  return (
    <button
      type="button"
      className="inline-flex items-center gap-0.5 rounded text-accent-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
      onClick={() => select({ type: 'device', id })}
    >
      {d?.label ?? id}
      <ArrowUpRight size={11} aria-hidden="true" />
    </button>
  );
}

function Fields({ fields }: { fields: Readonly<Record<string, ViewField>> }) {
  const entries = Object.entries(fields);
  if (entries.length === 0) return <p className="text-xs text-ink-muted">No fields.</p>;
  return (
    <dl
      className="grid grid-cols-[minmax(0,9rem)_1fr] gap-x-3 gap-y-0.5 text-xs"
      data-testid="inspector-fields"
    >
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="truncate text-ink-muted" title={k}>
            {humanizeKey(k)}
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
  const manual = useUi((s) => s.manual);
  const params = Object.entries(spec.params ?? {});
  const initial = () => {
    const out: Record<string, string | number> = {};
    const fields = 'fields' in current ? current.fields : {};
    for (const [key, p] of params) {
      const fieldVal =
        key === 'mode' ? fields.bondMode : key === 'rate' ? fields.lacpRate : undefined;
      const match = p.choices.find((c) => c === fieldVal);
      out[key] = match ?? p.choices[0] ?? '';
    }
    return out;
  };
  const [values, setValues] = useState(initial);
  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-panel-2 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        apply(
          params.length ? { kind: spec.kind, target, params: values } : { kind: spec.kind, target },
        );
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{spec.label}</div>
        {spec.description ? (
          <div className="text-[11px] text-ink-muted">{spec.description}</div>
        ) : null}
      </div>
      {params.map(([key, p]) => (
        <Select
          key={key}
          label={p.label}
          value={String(values[key] ?? '')}
          onChange={(e) => {
            const choice = p.choices.find((c) => String(c) === e.target.value);
            if (choice !== undefined) setValues((v) => ({ ...v, [key]: choice }));
          }}
        >
          {p.choices.map((c) => (
            <option key={String(c)} value={String(c)}>
              {key === 'mode' ? (BOND_MODE_LABEL[String(c)] ?? String(c)) : String(c)}
            </option>
          ))}
        </Select>
      ))}
      <Button
        type="submit"
        size="sm"
        variant={spec.kind === 'fail' ? 'danger' : 'default'}
        data-testid={`action-${spec.kind}`}
      >
        {manual ? 'Queue' : 'Apply'}
      </Button>
    </form>
  );
}

function Actions({ target, view }: { target: string; view: DeviceView | LinkView }) {
  const sim = useSim();
  const snapshot = useSnapshot();
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-query when the snapshot changes
  const specs = useMemo(() => sim.availableActions(target), [sim, target, snapshot.version]);
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

function PathUsageSection({ snapshot, vmId }: { snapshot: Snapshot; vmId: string }) {
  // Same rolling window as the diagram, so shares don't jump with per-tick round-robin.
  const activityTicks = useUi((s) => s.activityTicks);
  const win = useActivityWindow(snapshot, activityTicks);
  const usage = computePathUsage(win.snapshot, vmId);
  const windowLabel = win.ticks === 1 ? 'last tick' : `last ${win.ticks} ticks`;
  if (!usage) return null;
  return (
    <Section title="Path usage" testId="path-usage">
      <div className="mb-2 flex items-center gap-1 text-xs">
        <Route size={13} className="text-accent-ink" aria-hidden="true" />
        Owning CVM:{' '}
        {usage.cvmId ? (
          <DeviceLink id={usage.cvmId} />
        ) : (
          <span className="text-ink-muted">none (compute-only)</span>
        )}
      </div>
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
          <p className="text-xs text-ink-muted">No storage traffic in the {windowLabel}.</p>
        )}
      </div>
      {usage.targets.length ? (
        <>
          <p className="mb-1 text-[11px] text-ink-muted">Array ports</p>
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
      <p className="mt-2 text-[10px] text-ink-muted">
        Paths are per host until traces carry a VM/vDisk id. Highlighted on the diagram.
      </p>
    </Section>
  );
}

function BondSection({ snapshot, hostId }: { snapshot: Snapshot; hostId: string }) {
  const bondUtilHost = useUi((s) => s.bondUtilHost);
  const setBondUtilHost = useUi((s) => s.setBondUtilHost);
  const activityTicks = useUi((s) => s.activityTicks);
  const win = useActivityWindow(snapshot, activityTicks);
  const bonds = bondUtilization(win.snapshot, hostId);
  if (bonds.length === 0) return null;
  const on = bondUtilHost === hostId;
  return (
    <Section title="Bond member utilization" testId="bond-util">
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
              <ShareBar
                key={m.nicId}
                label={m.label}
                share={m.share}
                down={m.status === 'down'}
                detail={Object.entries(m.byCategory)
                  .map(([c, n]) => `${trafficStyle(c).label}: ${n}`)
                  .join(', ')}
              />
            ))}
          </div>
        </div>
      ))}
    </Section>
  );
}

function DeviceInspector({ device }: { device: DeviceView }) {
  const snapshot = useSnapshot();
  const children = Object.values(snapshot.devices).filter((d) => d.parent === device.id);
  const host = ancestorOfKind(snapshot.devices, device.id, 'ahv-host');
  const showBond = device.kind === 'ahv-host' || device.kind === 'vswitch';
  return (
    <div data-testid="inspector-device">
      <header className="px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-base font-semibold" data-testid="inspector-title">
            {device.label}
          </h2>
          <StatusPill status={device.status} />
        </div>
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
        {device.parent ? (
          <div className="mt-1 text-xs text-ink-muted">
            In <DeviceLink id={device.parent} />
          </div>
        ) : null}
      </header>
      <Section title="State">
        <Fields fields={device.fields} />
      </Section>
      {device.kind === 'vm' ? <PathUsageSection snapshot={snapshot} vmId={device.id} /> : null}
      {showBond && host ? <BondSection snapshot={snapshot} hostId={host.id} /> : null}
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

function LinkInspector({ link }: { link: LinkView }) {
  const total = Object.values(link.util).reduce((s, v) => s + v, 0);
  return (
    <div data-testid="inspector-link">
      <header className="px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="truncate font-mono text-base font-semibold" data-testid="inspector-title">
            {link.id}
          </h2>
          <StatusPill status={link.status === 'up' ? 'healthy' : 'failed'} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
          <DeviceLink id={link.a.device} />{' '}
          <span className="font-mono text-ink-muted">{link.a.port}</span>
          <span aria-hidden="true">↔</span>
          <DeviceLink id={link.b.device} />{' '}
          <span className="font-mono text-ink-muted">{link.b.port}</span>
        </div>
      </header>
      <Section title="State">
        <Fields fields={{ status: link.status, mtu: link.mtu, latencyMs: link.latencyMs }} />
      </Section>
      <Section title="Utilization (last tick)">
        {total === 0 ? (
          <p className="text-xs text-ink-muted">No delivered traffic.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {Object.entries(link.util).map(([c, n]) => (
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
      <p className="mb-3 text-sm text-ink-muted">
        Select a device or cable on the diagram (right-click for quick fail/recover), or pick one
        here.
      </p>
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
