/**
 * A physical cable. The path comes from `geometry.ts` (via `data.pathD`), not from React Flow's
 * handle positions, so the SVG and the packet overlay always agree. Never `animated: true`:
 * packets are drawn on the canvas overlay instead (SPEC §3).
 */

import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';
import { Unplug } from 'lucide-react';
import type { IoHop } from '../data-path';
import type { CableEdge } from '../flow';
import { LineBars } from '../nodes/meter-bars';
import { DROP_COLOR } from '../traffic';

/** Style of an internal I/O hop by state: the active path is highlighted, the rest is quiet. */
function hopStyle(state: IoHop['state']): {
  stroke: string;
  width: number;
  dash: string | undefined;
  opacity: number;
} {
  switch (state) {
    case 'active':
      return { stroke: 'var(--color-accent)', width: 2.5, dash: undefined, opacity: 1 };
    case 'stalled':
      return { stroke: 'var(--color-status-stalled)', width: 2.5, dash: '2 4', opacity: 1 };
    case 'down':
      return { stroke: 'var(--color-status-failed)', width: 2, dash: '6 4', opacity: 1 };
    case 'standby':
      return { stroke: 'var(--color-cable)', width: 1.5, dash: '3 4', opacity: 0.7 };
    default:
      return { stroke: 'var(--color-cable)', width: 1.25, dash: undefined, opacity: 0.55 };
  }
}

export function CableEdgeView({ id, data, selected }: EdgeProps<CableEdge>) {
  if (!data) return null;
  const down = data.link.status === 'down';
  if (data.io) {
    const h = hopStyle(down ? 'down' : data.io.state);
    return (
      <>
        <BaseEdge
          id={id}
          path={data.pathD}
          interactionWidth={10}
          className="nv-edge"
          style={{
            stroke: selected ? 'var(--color-focus)' : h.stroke,
            strokeWidth: h.width,
            strokeDasharray: h.dash,
            opacity: data.dim ? 0.15 : h.opacity,
          }}
        />
        <path
          d={data.pathD}
          fill="none"
          stroke="none"
          data-testid={`io-hop-${id}`}
          data-state={down ? 'down' : data.io.state}
        />
      </>
    );
  }
  const stroke = selected
    ? 'var(--color-focus)'
    : down
      ? 'var(--color-status-failed)'
      : data.inPath || data.ioActive
        ? 'var(--color-accent)'
        : 'var(--color-cable)';
  const width = selected || data.inPath || data.ioActive ? 2.5 : 1.5;
  return (
    <>
      {data.glow ? (
        <path
          d={data.pathD}
          fill="none"
          stroke={data.dropped ? DROP_COLOR : data.glow}
          strokeWidth={6}
          strokeOpacity={data.glowOpacity}
          strokeLinecap="round"
          data-testid={`glow-${id}`}
        />
      ) : null}
      <BaseEdge
        id={id}
        path={data.pathD}
        interactionWidth={14}
        className="nv-edge"
        style={{
          stroke,
          strokeWidth: width,
          strokeDasharray: down ? '6 4' : undefined,
          opacity: data.dim ? 0.2 : 1,
        }}
      />
      {down || data.label || data.meter ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute flex items-center gap-1"
            style={{
              transform: `translate(-50%, -50%) translate(${data.mid.x}px, ${data.mid.y}px)`,
            }}
            data-testid={`edge-label-${id}`}
          >
            {down ? (
              <span
                className="inline-flex items-center rounded-full border border-status-failed/60 bg-panel p-0.5 text-status-failed"
                title="Cable down"
              >
                <Unplug size={10} aria-hidden="true" />
                <span className="sr-only">down</span>
              </span>
            ) : null}
            {data.meter ? (
              <span className="w-10 rounded border border-border bg-panel px-0.5 py-px">
                <LineBars meter={data.meter} />
              </span>
            ) : null}
            {data.label ? (
              <span
                className={`whitespace-pre rounded border bg-panel px-1 text-center font-mono text-[9px] leading-tight ${
                  data.labelTone === 'full'
                    ? 'border-status-failed/70 text-status-failed'
                    : data.labelTone === 'busy'
                      ? 'border-status-degraded/70 text-status-degraded'
                      : 'border-accent/40 text-accent-ink'
                }`}
                data-tone={data.labelTone ?? undefined}
              >
                {data.label}
              </span>
            ) : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
