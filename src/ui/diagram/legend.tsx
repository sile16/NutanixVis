import { clsx } from 'clsx';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
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

const OPEN_KEY = 'nutanixvis.legend.open';

/** Remembered per browser (a viewer convenience); storage may be unavailable. */
function readOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeOpen(open: boolean): void {
  try {
    globalThis.localStorage?.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
}

const PATH_KEY = [
  { label: 'I/O path in use', stroke: 'var(--color-accent)', w: 2.5, dash: undefined },
  { label: 'idle', stroke: 'var(--color-cable)', w: 1.25, dash: undefined },
  { label: 'standby member', stroke: 'var(--color-cable)', w: 1.5, dash: '3 4' },
  { label: 'stalled', stroke: 'var(--color-status-stalled)', w: 2.5, dash: '2 4' },
  { label: 'down', stroke: 'var(--color-status-failed)', w: 2, dash: '6 4' },
] as const;

/**
 * Traffic legend and filter (SPEC §8): one toggle per category seen in the activity window, plus
 * presets. Hidden categories are neither animated nor counted in the cable glow or hover card;
 * the choice lives in the UI store and survives topology switches.
 */
export function Legend({
  categories,
  dropped,
  animated,
  hasPath = false,
  speeds = false,
}: {
  /** Categories seen in the activity window (sorted). */
  categories: readonly string[];
  dropped: boolean;
  animated: boolean;
  /** The diagram draws the internal I/O data path: show its line key. */
  hasPath?: boolean;
  /** Cables carry speed labels and line-rate bars: say what the numbers and bars mean. */
  speeds?: boolean;
}) {
  const traffic = useUi((s) => s.traffic);
  const toggle = useUi((s) => s.toggleTraffic);
  const setPreset = useUi((s) => s.setTrafficPreset);
  const hidden = categories.filter((c) => !isCategoryVisible(traffic, c)).length;
  // Collapsible: on a small screen the legend would cover part of the diagram.
  const [open, setOpen] = useState(readOpen);
  return (
    <section
      aria-label="Traffic legend and filter"
      className="nopan nodrag max-w-[19rem] rounded-md border border-border bg-panel/95 px-2 py-1.5 text-[11px] shadow-sm"
      data-testid="traffic-legend"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          writeOpen(!open);
        }}
        className={clsx(
          'flex w-full items-center gap-0.5 rounded text-left font-semibold text-ink-muted focus-visible:outline-2 focus-visible:outline-focus',
          open && 'mb-1',
        )}
        title={open ? 'Hide the legend' : 'Show the legend'}
        data-testid="legend-toggle"
      >
        {open ? (
          <ChevronDown size={12} aria-hidden="true" />
        ) : (
          <ChevronRight size={12} aria-hidden="true" />
        )}
        Traffic{' '}
        <span className="font-normal">
          {animated ? '(dots and glow: recent activity)' : '(reduced motion: highlighted)'}
        </span>
        {!open && hidden > 0 ? <span className="ml-auto font-normal">{hidden} hidden</span> : null}
      </button>
      {open ? (
        <>
          <fieldset className="m-0 border-0 p-0">
            <legend className="sr-only">Show traffic categories</legend>
            <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
              {categories.map((c) => {
                const style = trafficStyle(c);
                const on = isCategoryVisible(traffic, c);
                const tip = style.description
                  ? `${style.label}: ${style.description}`
                  : style.label;
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
            </ul>
          </fieldset>
          {hasPath ? (
            <ul
              className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 border-t border-border pt-1 text-[10px]"
              data-testid="io-path-legend"
              aria-label="I/O path line styles"
            >
              {PATH_KEY.map((k) => (
                <li key={k.label} className="flex items-center gap-1">
                  <svg width="22" height="6" aria-hidden="true">
                    <line
                      x1="0"
                      y1="3"
                      x2="22"
                      y2="3"
                      stroke={k.stroke}
                      strokeWidth={k.w}
                      strokeDasharray={k.dash}
                    />
                  </svg>
                  {k.label}
                </li>
              ))}
            </ul>
          ) : null}
          {speeds ? (
            <p
              className="mt-1 border-t border-border pt-1 text-[10px] text-ink-muted"
              data-testid="speed-legend"
            >
              <span className="font-mono text-ink">↓21 ↑50</span> Gb/s each way · bars: % of line
              rate (amber 80 %, red full) · bond and Stargate bars: share of traffic
            </p>
          ) : null}
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
        </>
      ) : null}
    </section>
  );
}
