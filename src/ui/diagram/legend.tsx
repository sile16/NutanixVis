import { clsx } from 'clsx';
import { useUi } from '../store/ui-store';
import { DROP_COLOR, isCategoryVisible, type TrafficPreset, trafficStyle } from './traffic';

const PRESETS: readonly { id: TrafficPreset; label: string; title: string }[] = [
  { id: 'all', label: 'All', title: 'Show every kind of traffic' },
  {
    id: 'storage',
    label: 'Storage IO only',
    title: 'Only data IO: reads, writes, NVMe/TCP IO, replication and rebuild',
  },
  { id: 'none', label: 'None', title: 'Hide all traffic (cable states stay visible)' },
];

/**
 * Traffic legend and filter (SPEC §8): one toggle per category seen in the activity window, plus
 * presets. Hidden categories are neither animated nor counted in the cable glow or hover card;
 * the choice lives in the UI store and survives topology switches.
 */
export function Legend({
  categories,
  dropped,
  animated,
  reducedMotion,
}: {
  /** Categories seen in the activity window (sorted). */
  categories: readonly string[];
  dropped: boolean;
  animated: boolean;
  reducedMotion: boolean;
}) {
  const traffic = useUi((s) => s.traffic);
  const toggle = useUi((s) => s.toggleTraffic);
  const setPreset = useUi((s) => s.setTrafficPreset);
  const hidden = categories.filter((c) => !isCategoryVisible(traffic, c)).length;
  return (
    <section
      aria-label="Traffic legend and filter"
      className="nopan nodrag max-w-[19rem] rounded-md border border-border bg-panel/95 px-2 py-1.5 text-[11px] shadow-sm"
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
      <fieldset className="m-0 border-0 p-0">
        <legend className="sr-only">Show traffic categories</legend>
        <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
          {categories.map((c) => {
            const style = trafficStyle(c);
            const on = isCategoryVisible(traffic, c);
            const tip = style.description ? `${style.label}: ${style.description}` : style.label;
            return (
              <li key={c}>
                <label
                  className={clsx(
                    'flex cursor-pointer items-center gap-1 rounded px-0.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus',
                    !on && 'text-ink-muted line-through',
                  )}
                  title={tip}
                  data-testid={`legend-${c}`}
                  data-visible={on ? 'true' : 'false'}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(c)}
                    className="size-3 accent-[var(--color-accent)]"
                    title={tip}
                  />
                  <span
                    className="inline-block size-2.5 rounded-full border border-white/70"
                    style={{ background: style.color, opacity: on ? 1 : 0.35 }}
                    aria-hidden="true"
                  />
                  {style.label}
                </label>
              </li>
            );
          })}
          {dropped ? (
            <li className="flex items-center gap-1" title="Dropped where the × is drawn">
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
          {categories.length === 0 ? <li className="text-ink-muted">No recent traffic</li> : null}
        </ul>
      </fieldset>
      <fieldset className="m-0 mt-1 flex flex-wrap items-center gap-1 border-0 p-0">
        <legend className="sr-only">Traffic presets</legend>
        {PRESETS.map((p) => {
          const active = traffic.preset === p.id && Object.keys(traffic.overrides).length === 0;
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={active}
              title={p.title}
              onClick={() => setPreset(p.id)}
              data-testid={`traffic-preset-${p.id}`}
              className={clsx(
                'rounded border px-1.5 py-px text-[10px] focus-visible:outline-2 focus-visible:outline-focus',
                active
                  ? 'border-accent bg-accent/10 text-accent-ink'
                  : 'border-border text-ink-muted hover:bg-hover hover:text-ink',
              )}
            >
              {p.label}
            </button>
          );
        })}
        {hidden > 0 ? (
          <span className="ml-auto text-[10px] text-ink-muted" data-testid="traffic-hidden">
            {hidden} hidden
          </span>
        ) : null}
      </fieldset>
    </section>
  );
}
