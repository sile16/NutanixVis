/** Events tab (SPEC §8): filterable log by severity and device, with causal links. */
import { BookOpen, CornerDownRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Severity } from '../../engine/types';
import { formatSimTime } from '../app/format';
import { Select } from '../components/controls';
import { isDescendant } from '../diagram/path-usage';
import { useSim, useSnapshot } from '../store/sim-context';
import { useUi } from '../store/ui-store';
import { eventId, filterEvents, indexEvents, SEVERITIES } from './events-model';
import { SEVERITY_META, SeverityTag } from './severity';

const MAX_ROWS = 300;

export function EventsPanel() {
  const sim = useSim();
  const snapshot = useSnapshot();
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const explain = useUi((s) => s.explain);
  const [minSeverity, setMinSeverity] = useState<Severity>('info');
  const [scope, setScope] = useState<'all' | 'selected'>('all');

  // biome-ignore lint/correctness/useExhaustiveDependencies: the log grows per snapshot version
  const log = useMemo(() => [...sim.eventLog()], [sim, snapshot.version]);
  const index = useMemo(() => indexEvents(log), [log]);
  const deviceId = scope === 'selected' && selection?.type === 'device' ? selection.id : null;
  const rows = filterEvents(log, { minSeverity, deviceId }, (d, a) =>
    isDescendant(snapshot.devices, d, a),
  )
    .reverse()
    .slice(0, MAX_ROWS);

  return (
    <div className="flex h-full flex-col" data-testid="events-panel">
      <div className="flex flex-wrap gap-2 border-b border-border px-3 py-2">
        <Select
          label="Min severity"
          value={minSeverity}
          onChange={(e) => {
            const s = SEVERITIES.find((x) => x === e.target.value);
            if (s) setMinSeverity(s);
          }}
          data-testid="events-severity"
        >
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {SEVERITY_META[s].label}
            </option>
          ))}
        </Select>
        <Select
          label="Device"
          value={scope}
          onChange={(e) => setScope(e.target.value === 'selected' ? 'selected' : 'all')}
          data-testid="events-scope"
        >
          <option value="all">All devices</option>
          <option value="selected" disabled={selection?.type !== 'device'}>
            Selected
            {selection?.type === 'device'
              ? `: ${snapshot.devices[selection.id]?.label ?? selection.id}`
              : ''}{' '}
            (incl. children)
          </option>
        </Select>
        <span className="self-end pb-1.5 text-[11px] text-ink-muted">{rows.length} shown</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-3 text-sm text-ink-muted">
          No events yet. Step time or inject a failure.
        </p>
      ) : (
        <ol className="flex-1 divide-y divide-border overflow-y-auto">
          {rows.map((e) => {
            const causes = e.causeIds.map((c) => index.get(c)).filter((x) => x !== undefined);
            return (
              <li
                key={eventId(e)}
                className="px-3 py-1.5 text-xs"
                data-testid="event-row"
                data-code={e.code}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-ink-muted">{formatSimTime(e.t)}</span>
                  <SeverityTag severity={e.severity} />
                  {e.deviceId ? (
                    <button
                      type="button"
                      className="truncate text-accent-ink hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                      onClick={() => select({ type: 'device', id: e.deviceId ?? '' })}
                    >
                      {snapshot.devices[e.deviceId]?.label ?? e.deviceId}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="ml-auto inline-flex items-center gap-0.5 rounded px-1 text-ink-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
                    onClick={() => explain(e.seq)}
                    aria-label={`Explain event ${e.code}`}
                  >
                    <BookOpen size={11} aria-hidden="true" /> Explain
                  </button>
                </div>
                <p className="mt-0.5">{e.text}</p>
                <div className="font-mono text-[10px] text-ink-muted">{e.code}</div>
                {causes.map((c) => (
                  <button
                    key={eventId(c)}
                    type="button"
                    onClick={() => explain(c.seq)}
                    className="mt-0.5 flex items-center gap-1 text-left text-[11px] text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    <CornerDownRight size={11} aria-hidden="true" />
                    caused by <span className="font-mono">{c.code}</span> at {formatSimTime(c.t)}
                  </button>
                ))}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
