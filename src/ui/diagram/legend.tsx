import type { Trace } from '../../engine/types';
import { DROP_COLOR, TRAFFIC, trafficStyle } from './traffic';

/** Traffic-category legend: categories seen this tick, plus the dropped-packet marker. */
export function Legend({
  traces,
  animated,
  reducedMotion,
}: {
  traces: readonly Trace[];
  animated: boolean;
  reducedMotion: boolean;
}) {
  const seen = [...new Set(traces.map((t) => t.category))].sort(
    (a, b) => Object.keys(TRAFFIC).indexOf(a) - Object.keys(TRAFFIC).indexOf(b),
  );
  const dropped = traces.some((t) => t.result === 'dropped');
  return (
    <section
      aria-label="Traffic legend"
      className="max-w-[16rem] rounded-md border border-border bg-panel/95 px-2 py-1.5 text-[11px] shadow-sm"
      data-testid="traffic-legend"
    >
      <div className="mb-1 font-semibold text-ink-muted">
        Traffic{' '}
        <span className="font-normal">
          {animated
            ? '(packets: this tick; glow: recent)'
            : reducedMotion
              ? '(reduced motion: highlighted)'
              : '(packets off: highlighted)'}
        </span>
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
        {seen.map((c) => (
          <li key={c} className="flex items-center gap-1">
            <span
              className="inline-block size-2.5 rounded-full border border-white/70"
              style={{ background: trafficStyle(c).color }}
              aria-hidden="true"
            />
            {trafficStyle(c).label}
          </li>
        ))}
        {dropped ? (
          <li className="flex items-center gap-1">
            <span
              className="font-bold leading-none"
              style={{ color: DROP_COLOR }}
              aria-hidden="true"
            >
              ×
            </span>
            Dropped
          </li>
        ) : null}
        {seen.length === 0 ? <li className="text-ink-muted">No traffic this tick</li> : null}
      </ul>
    </section>
  );
}
