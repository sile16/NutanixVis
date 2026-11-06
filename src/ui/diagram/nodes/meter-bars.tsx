/**
 * Throughput meters drawn inside a device card (`meters.ts`): two line-rate bars (one per
 * direction) for a NIC or the ISL, and a distribution bar for a bond or Stargate.
 */
import clsx from 'clsx';
import type { LineMeter, MeterTone, ShareSlice } from '../meters';

const TONE: Readonly<Record<MeterTone, string>> = {
  ok: 'bg-accent',
  busy: 'bg-status-degraded',
  full: 'bg-status-failed',
};

const pct = (x: number) => `${Math.round(Math.min(1, x) * 100)}%`;
const gb = (g: number) => (g >= 10 ? Math.round(g) : Math.round(g * 10) / 10);

/** Two bars, one per direction: share of the cable's line rate. `row`: side by side. */
export function LineBars({
  meter,
  className,
  row = false,
}: {
  meter: LineMeter;
  className?: string;
  row?: boolean;
}) {
  const title = meter.dirs
    .map(
      (d) => `${d.arrow} ${gb(d.gbps)} of ${meter.capacityGbps} Gb/s (${pct(d.util)} of line rate)`,
    )
    .join('\n');
  return (
    <span
      className={clsx(
        'pointer-events-auto flex',
        row ? 'flex-row gap-1.5' : 'flex-col gap-px',
        className,
      )}
      title={title}
      data-testid="line-bars"
      role="img"
      aria-label={`line rate: ${meter.dirs.map((d) => `${d.arrow} ${pct(d.util)}`).join(', ')}`}
    >
      {meter.dirs.map((d) => (
        <span
          key={d.arrow}
          className={clsx('flex items-center gap-0.5', row && 'flex-1')}
          data-tone={d.tone}
        >
          <span className="w-2 text-center font-mono text-[7px] leading-none text-ink-muted">
            {d.arrow}
          </span>
          <span className="h-[3px] flex-1 overflow-hidden rounded-full bg-hover">
            <span
              className={clsx('block h-full rounded-full', TONE[d.tone])}
              style={{ width: pct(d.util) }}
            />
          </span>
        </span>
      ))}
    </span>
  );
}

/** Distribution bar: what share each member (or interface) carries, with the numbers. */
export function ShareBars({
  slices,
  what,
  className,
  inline = false,
  shortLabel = (l) => l,
}: {
  slices: readonly ShareSlice[];
  what: string;
  className?: string;
  /** One row (bar, then the numbers) for a one-line card. */
  inline?: boolean;
  shortLabel?: (label: string) => string;
}) {
  const full = slices.map((s) => `${s.label} ${pct(s.share)}`).join(' · ');
  const text = slices.map((s) => `${shortLabel(s.label)} ${pct(s.share)}`).join(' · ');
  if (inline) {
    return (
      <span
        className={clsx('flex min-w-0 items-center gap-1', className)}
        title={`${what}: ${full}`}
        data-testid="share-bars"
        role="img"
        aria-label={`${what}: ${full}`}
      >
        <span className="flex h-[4px] w-10 shrink-0 gap-px overflow-hidden rounded-full bg-hover">
          {slices.map((s, i) => (
            <span
              key={s.id}
              className={clsx('block h-full', i % 2 === 0 ? 'bg-accent' : 'bg-accent/45')}
              style={{ width: pct(s.share) }}
            />
          ))}
        </span>
        <span className="truncate font-mono text-[8px] text-ink-muted">{text}</span>
      </span>
    );
  }
  return (
    <span
      className={clsx('flex flex-col gap-px', className)}
      title={`${what}: ${full}`}
      data-testid="share-bars"
      role="img"
      aria-label={`${what}: ${full}`}
    >
      <span className="flex h-[4px] gap-px overflow-hidden rounded-full bg-hover">
        {slices.map((s, i) => (
          <span
            key={s.id}
            className={clsx('block h-full', i % 2 === 0 ? 'bg-accent' : 'bg-accent/45')}
            style={{ width: pct(s.share) }}
          />
        ))}
      </span>
      <span className="truncate text-center font-mono text-[7px] leading-none text-ink-muted">
        {text}
      </span>
    </span>
  );
}
