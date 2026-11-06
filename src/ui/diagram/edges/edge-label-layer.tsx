/**
 * Cable labels and the ISL's line-rate bars, drawn in their own layer above the traffic-dot canvas
 * (`packet-overlay.tsx`), so a passing dot never covers the numbers. It follows the viewport through
 * React Flow's public `useViewport()`; positions come from `label-anchor.ts` via the edge data.
 */
import { useViewport } from '@xyflow/react';
import clsx from 'clsx';
import type { CableEdge } from '../flow';
import { LineBars } from '../nodes/meter-bars';

const TONE = {
  full: 'border-status-failed/70 text-status-failed',
  busy: 'border-status-degraded/70 text-status-degraded',
  ok: 'border-accent/40 text-accent-ink',
} as const;

export function EdgeLabelLayer({ edges }: { edges: readonly CableEdge[] }) {
  const { x, y, zoom } = useViewport();
  const labeled = edges.filter(
    (e) => e.data && e.data.link.status !== 'down' && (e.data.label || e.data.meter),
  );
  if (labeled.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[4] overflow-hidden">
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{ transform: `translate(${x}px, ${y}px) scale(${zoom})` }}
      >
        {labeled.map((e) => {
          const d = e.data;
          if (!d) return null;
          const at = d.labelAt;
          const below = at.place === 'below';
          // One box: the ISL's line-rate bars above its speeds and crossing share.
          return (
            <div
              key={e.id}
              className={clsx('absolute', d.dim && 'opacity-30')}
              style={{
                transform: `translate(-50%, ${below ? '0' : '-50%'}) translate(${at.x}px, ${at.y}px)`,
              }}
              data-testid={`edge-label-${e.id}`}
            >
              {d.label || d.meter ? (
                <span
                  className={clsx(
                    'pointer-events-auto flex flex-col items-stretch gap-0.5 whitespace-pre rounded border bg-panel px-1 py-px text-center font-mono text-[9px] leading-tight',
                    TONE[d.labelTone ?? 'ok'],
                  )}
                  title={d.labelTitle ?? undefined}
                  data-tone={d.labelTone ?? undefined}
                >
                  {d.meter ? <LineBars meter={d.meter} className="mx-auto w-16" /> : null}
                  {d.label}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
