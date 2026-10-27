import { CircleCheck, CircleX } from 'lucide-react';
import { useRef } from 'react';
import { formatSimTime } from '../app/format';
import { useClampedPosition } from '../components/clamp';
import { useSnapshot } from '../store/sim-context';
import { useUi } from '../store/ui-store';
import type { TraceHistoryEntry } from './hooks';
import { trafficStyle } from './traffic';

const MAX_ROWS = 8;

/** Hovering a cable lists the recent traces that crossed it (SPEC §8). */
export function LinkHoverCard({ history }: { history: readonly TraceHistoryEntry[] }) {
  const hovered = useUi((s) => s.hoveredLink);
  const snapshot = useSnapshot();
  const ref = useRef<HTMLDivElement>(null);
  const pos = useClampedPosition(ref, hovered ? { x: hovered.x + 14, y: hovered.y + 14 } : null);
  if (!hovered) return null;
  const link = snapshot.links[hovered.id];
  if (!link) return null;
  const rows = history.flatMap((h) =>
    h.traces.filter((t) => t.links.includes(hovered.id)).map((t) => ({ t, at: h.simTime })),
  );
  const label = (id: string) => snapshot.devices[id]?.label ?? id;
  return (
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-50 w-72 rounded-md border border-border bg-panel p-2 text-xs shadow-lg"
      style={{ left: pos?.x ?? hovered.x + 14, top: pos?.y ?? hovered.y + 14 }}
      data-testid="link-hover-card"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-mono font-semibold">{link.id}</span>
        <span className={link.status === 'up' ? 'text-status-healthy' : 'text-status-failed'}>
          {link.status === 'up' ? 'up' : 'down'} · MTU {link.mtu}
        </span>
      </div>
      <div className="mb-1 text-ink-muted">
        {label(link.a.device)} {link.a.port} ↔ {label(link.b.device)} {link.b.port}
      </div>
      {rows.length === 0 ? (
        <div className="text-ink-muted">
          No traces in the last {history.length === 1 ? 'tick' : `${history.length} ticks`}.
        </div>
      ) : (
        <ul className="space-y-0.5">
          {rows.slice(0, MAX_ROWS).map(({ t, at }) => (
            <li key={`${at}-${t.msgId}`} className="flex items-center gap-1.5">
              <span className="font-mono text-ink-muted">{formatSimTime(at)}</span>
              <span
                className="inline-block size-2 rounded-full"
                style={{ background: trafficStyle(t.category).color }}
                aria-hidden="true"
              />
              <span className="truncate">{t.kind}</span>
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
