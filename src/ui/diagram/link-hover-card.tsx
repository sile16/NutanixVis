import { CircleCheck, CircleX } from 'lucide-react';
import { useRef } from 'react';
import { useClampedPosition } from '../components/clamp';
import { deviceName, linkName } from '../panels/events-model';
import { StepTag } from '../steps/step-tag';
import { useSnapshot } from '../store/sim-context';
import { useUi } from '../store/ui-store';
import type { IoHop } from './data-path';
import type { TraceHistoryEntry } from './hooks';
import { trafficStyle } from './traffic';

const MAX_ROWS = 8;

/** Hovering a cable lists the recent traces that crossed it (SPEC §8). */
export function LinkHoverCard({
  history,
  hops,
}: {
  history: readonly TraceHistoryEntry[];
  hops: ReadonlyMap<string, IoHop>;
}) {
  const hovered = useUi((s) => s.hoveredLink);
  const snapshot = useSnapshot();
  const ref = useRef<HTMLDivElement>(null);
  const pos = useClampedPosition(ref, hovered ? { x: hovered.x + 14, y: hovered.y + 14 } : null);
  if (!hovered) return null;
  const hop = hops.get(hovered.id);
  if (hop) return <HopCard hop={hop} hovered={hovered} />;
  const link = snapshot.links[hovered.id];
  if (!link) return null;
  const rows = history.flatMap((h) =>
    h.traces.filter((t) => t.links.includes(hovered.id)).map((t) => ({ t, at: h.simTime })),
  );
  const label = (id: string) => deviceName(snapshot.devices, id);
  // "NVMe/TCP IO", "NVMe/TCP IO reply": the traffic it is, not the simulator's message kind.
  const what = (kind: string, category: string) =>
    `${trafficStyle(category).label}${kind.endsWith('-resp') ? ' reply' : ''}`;
  return (
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-50 w-72 rounded-md border border-border bg-panel p-2 text-xs shadow-lg"
      style={{ left: pos?.x ?? hovered.x + 14, top: pos?.y ?? hovered.y + 14 }}
      data-testid="link-hover-card"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="truncate font-semibold" title={link.id}>
          {linkName(snapshot.devices, snapshot.links, link.id) ?? link.id}
        </span>
        <span className={link.status === 'up' ? 'text-status-healthy' : 'text-status-failed'}>
          {link.status === 'up' ? 'up' : 'down'} · MTU {link.mtu}
        </span>
      </div>
      <div className="mb-1 text-ink-muted">
        {label(link.a.device)} {link.a.port} ↔ {label(link.b.device)} {link.b.port}
      </div>
      {rows.length === 0 ? (
        <div className="text-ink-muted">No recent traces.</div>
      ) : (
        <ul className="space-y-0.5">
          {rows.slice(0, MAX_ROWS).map(({ t, at }) => (
            <li key={`${at}-${t.msgId}`} className="flex items-center gap-1.5">
              <StepTag t={at} />
              <span
                className="inline-block size-2 rounded-full"
                style={{ background: trafficStyle(t.category).color }}
                aria-hidden="true"
              />
              <span className="truncate" title={t.kind}>
                {what(t.kind, t.category)}
              </span>
              {t.result === 'delivered' ? (
                <span className="ml-auto inline-flex items-center gap-0.5 text-status-healthy">
                  <CircleCheck size={11} aria-hidden="true" /> delivered
                </span>
              ) : (
                <span className="ml-auto inline-flex items-center gap-0.5 text-status-failed">
                  <CircleX size={11} aria-hidden="true" /> {t.reason ?? 'dropped'}
                </span>
              )}
            </li>
          ))}
          {rows.length > MAX_ROWS ? (
            <li className="text-ink-muted">+{rows.length - MAX_ROWS} more</li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

const HOP_STATE: Readonly<Record<IoHop['state'], { label: string; cls: string }>> = {
  active: { label: 'carrying I/O', cls: 'text-accent-ink' },
  idle: { label: 'idle', cls: 'text-ink-muted' },
  standby: { label: 'standby', cls: 'text-ink-muted' },
  stalled: { label: 'stalled: I/O waits', cls: 'text-status-stalled' },
  down: { label: 'down', cls: 'text-status-failed' },
};

/** Hover card of an internal I/O hop: which hop, its state and why, and which VMs use it. */
function HopCard({ hop, hovered }: { hop: IoHop; hovered: { x: number; y: number } }) {
  const snapshot = useSnapshot();
  const ref = useRef<HTMLDivElement>(null);
  const pos = useClampedPosition(ref, { x: hovered.x + 14, y: hovered.y + 14 });
  const meta = HOP_STATE[hop.state];
  return (
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-50 w-72 rounded-md border border-border bg-panel p-2 text-xs shadow-lg"
      style={{ left: pos?.x ?? hovered.x + 14, top: pos?.y ?? hovered.y + 14 }}
      data-testid="link-hover-card"
      data-hop-state={hop.state}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-semibold">{hop.name}</span>
        <span className={meta.cls}>{meta.label}</span>
      </div>
      <p className="mb-1">{hop.reason}</p>
      {hop.redirected ? (
        <p className="mb-1 text-ink-muted">
          Redirected path: the VM is served by a CVM on another host.
        </p>
      ) : null}
      {hop.vms.length > 0 ? (
        <p className="text-ink-muted">
          VMs: {hop.vms.map((v) => snapshot.devices[v]?.label ?? v).join(', ')}
        </p>
      ) : null}
    </div>
  );
}
