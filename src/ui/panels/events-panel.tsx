/** Events tab (SPEC §8): filterable log by severity and device, with causal links. */
import { CornerDownRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Severity } from '../../engine/types';
import { Select } from '../components/controls';
import { isDescendant } from '../diagram/path-usage';
import { StepTag } from '../steps/step-tag';
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
        <ol className="flex-1" />
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
                  <StepTag t={e.t} />
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
                </div>
                <p className="mt-0.5">{e.text}</p>
                {e.log && e.log.lines.length > 0 ? (
                  <pre
                    className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-all rounded bg-hover px-1.5 py-0.5 font-mono text-[10px] leading-snug text-ink"
                    title={`What ${e.log.source} logs for this on the host (line format from the product's source; names are the simulator's)`}
                    data-testid="event-log-lines"
                  >
                    {e.log.lines.map((l) => `${e.log?.source}: ${l}`).join('\n')}
                  </pre>
                ) : null}
                <div className="font-mono text-[10px] text-ink-muted">{e.code}</div>
                {causes.map((c) => (
                  <div
                    key={eventId(c)}
                    className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-muted"
                  >
                    <CornerDownRight size={11} aria-hidden="true" />
                    caused by <span className="font-mono">{c.code}</span> at <StepTag t={c.t} />
                  </div>
                ))}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
