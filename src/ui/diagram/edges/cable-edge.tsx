/**
 * A physical cable. The path comes from `geometry.ts` (via `data.pathD`), not from React Flow's
 * handle positions, so the SVG and the packet overlay always agree. Never `animated: true`:
 * packets are drawn on the canvas overlay instead (SPEC §3).
 */
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';
import { Unplug } from 'lucide-react';
import type { CableEdge } from '../flow';
import { DROP_COLOR } from '../traffic';

export function CableEdgeView({ id, data, selected }: EdgeProps<CableEdge>) {
  if (!data) return null;
  const down = data.link.status === 'down';
  const stroke = selected
    ? 'var(--color-focus)'
    : down
      ? 'var(--color-status-failed)'
      : data.inPath
        ? 'var(--color-accent)'
        : 'var(--color-cable)';
  const width = selected || data.inPath ? 2.5 : 1.5;
  return (
    <>
      {data.glow ? (
        <path
          d={data.pathD}
          fill="none"
          stroke={data.dropped ? DROP_COLOR : data.glow}
          strokeWidth={6}
          strokeOpacity={0.35}
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
      {down || data.label ? (
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
            {data.label ? (
              <span className="rounded border border-accent/40 bg-panel px-1 font-mono text-[9px] text-accent-ink">
                {data.label}
              </span>
            ) : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
