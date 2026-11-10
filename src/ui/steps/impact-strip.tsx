/**
 * Per-VM impact strip: for each workload and each step, the worst it went through in that step:
 * normal, partly stalled (x % of its IO), all IO stalled, down (crashed, restarting, paused),
 * redirected via CVM x, or recovered, as colour plus icon plus text. It reads the steps view
 * only; time is steps, never seconds. A VM that nothing touched has no row, so the strip stays
 * compact.
 */
import { clsx } from 'clsx';
import {
  CircleAlert,
  CircleCheck,
  CirclePause,
  CircleX,
  type LucideIcon,
  Minus,
  Route,
} from 'lucide-react';
import { useMemo } from 'react';
import { useSnapshot, useSteps } from '../store/sim-context';
import { buildImpact, type CellKind, type ImpactCell, impactCacheFor } from './impact';

const KIND: Readonly<Record<CellKind, { Icon: LucideIcon; cls: string }>> = {
  normal: { Icon: Minus, cls: 'border-border bg-panel-2 text-ink-muted' },
  partial: {
    Icon: CircleAlert,
    cls: 'border-status-stalled/60 bg-status-stalled/15 text-status-stalled',
  },
  stalled: {
    Icon: CirclePause,
    cls: 'border-status-failed/60 bg-status-failed/15 text-status-failed',
  },
  down: {
    Icon: CircleX,
    cls: 'border-status-failed/60 bg-status-failed/25 text-status-failed',
  },
  redirected: { Icon: Route, cls: 'border-accent/60 bg-accent/15 text-accent-ink' },
  recovered: {
    Icon: CircleCheck,
    cls: 'border-status-healthy/60 bg-status-healthy/15 text-status-healthy',
  },
};

function Cell({ cell, step }: { cell: ImpactCell; step: number | 'now' }) {
  const { Icon, cls } = KIND[cell.kind];
  return (
    <span
      className={clsx('flex items-center gap-1 whitespace-nowrap rounded border px-1 py-px', cls)}
      data-testid="impact-cell"
      data-kind={cell.kind}
      data-step={step}
    >
      <Icon size={10} aria-hidden="true" />
      {cell.text}
    </span>
  );
}

/** Most step columns shown at once; earlier ones scroll away so the strip stays compact. */
const MAX_COLS = 8;

export function ImpactStrip() {
  const steps = useSteps();
  const snapshot = useSnapshot();
  const impact = useMemo(
    () => buildImpact(steps, snapshot, impactCacheFor(steps)),
    [steps, snapshot],
  );
  const first = Math.max(0, impact.steps + 1 - MAX_COLS);
  const cols = Array.from({ length: impact.steps + 1 - first }, (_, i) => first + i);

  return (
    <section
      aria-label="Per-VM impact by step"
      className="max-h-40 overflow-auto border-t border-border bg-panel px-3 py-1.5 text-[11px]"
      data-testid="impact-strip"
      data-rows={impact.rows.length}
    >
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
          VM impact by step
        </h2>
        <span className="text-ink-muted" data-testid="impact-summary">
          {impact.rows.length === 0
            ? // "0 steps" next to a running step counter (a planned array operation counts steps too)
              // would read as a contradiction: say what the zero is.
              `no VM interrupted (0 steps of stalled IO) · ${impact.unaffected} running normally`
            : `${impact.rows.length} VM${impact.rows.length === 1 ? '' : 's'} affected · ${impact.unaffected} running normally`}
        </span>
      </div>
      {impact.bondMoves.map((m) => (
        <p
          key={m}
          className="mb-0.5 flex items-center gap-1 text-status-healthy"
          data-testid="impact-bond"
        >
          <CircleCheck size={11} aria-hidden="true" />{' '}
          {/* With VMs affected, the stall came from elsewhere: the bond move itself cost nothing. */}
          {impact.rows.length === 0
            ? `0 steps, no interruption. ${m}`
            : `Bond failover took 0 steps: ${m}`}
        </p>
      ))}
      {impact.rows.length > 0 ? (
        <table className="w-full border-separate border-spacing-x-0.5 border-spacing-y-0.5">
          <thead>
            <tr className="text-left text-[10px] text-ink-muted">
              <th scope="col" className="w-16 font-medium">
                VM
              </th>
              {cols.map((c) => (
                <th key={c} scope="col" className="font-medium">
                  {c === 0 ? 'step 0' : `step ${c}`}
                </th>
              ))}
              {impact.now ? (
                <th scope="col" className="font-medium" data-testid="impact-now">
                  {impact.now === 'waiting' ? 'now (waiting)' : 'now'}
                </th>
              ) : null}
              <th scope="col" className="font-medium">
                result
              </th>
            </tr>
          </thead>
          <tbody>
            {impact.rows.map((r) => (
              <tr key={r.vm} data-testid="impact-row" data-vm={r.vm}>
                <th scope="row" className="whitespace-nowrap text-left font-medium">
                  {r.label}
                </th>
                {cols.map((c) => {
                  const cell = r.cells[c];
                  return <td key={c}>{cell ? <Cell cell={cell} step={c} /> : null}</td>;
                })}
                {impact.now ? <td>{r.now ? <Cell cell={r.now} step="now" /> : null}</td> : null}
                <td className="whitespace-nowrap text-ink-muted">{r.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
