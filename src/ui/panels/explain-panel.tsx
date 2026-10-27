/**
 * Explain tab (placeholder, SPEC §8): renders an event's causal chain with its text, citation
 * ids (resolved against the public citation registry when possible) and confidence badges.
 * The narrative layer arrives with integration (stream I).
 */
import { ExternalLink } from 'lucide-react';
import { useMemo } from 'react';
import { citations } from '../../domain/citations';
import type { SimEvent } from '../../engine/types';
import { formatSimTime } from '../app/format';
import { ConfidenceBadge } from '../components/status';
import { useSim, useSnapshot } from '../store/sim-context';
import { useUi } from '../store/ui-store';
import { causalChain, eventId, indexEvents } from './events-model';
import { SeverityTag } from './severity';

function Cite({ id }: { id: string }) {
  const c = citations[id];
  if (!c) {
    return (
      <span
        className="rounded border border-dashed border-border px-1 font-mono text-[10px] text-ink-muted"
        title="Not in the citation registry yet"
      >
        {id}
      </span>
    );
  }
  return (
    <a
      href={c.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 rounded border border-border px-1 text-[10px] text-accent-ink hover:underline"
      title={`${c.publisher} · retrieved ${c.retrieved}`}
    >
      {c.title}
      <ExternalLink size={10} aria-hidden="true" />
    </a>
  );
}

function EventCard({ e, step }: { e: SimEvent; step?: number }) {
  return (
    <li
      className="rounded-md border border-border bg-panel-2 p-2 text-xs"
      data-testid="explain-step"
    >
      <div className="mb-0.5 flex items-center gap-2">
        {step !== undefined ? <span className="font-mono text-ink-muted">{step}.</span> : null}
        <span className="font-mono text-ink-muted">{formatSimTime(e.t)}</span>
        <SeverityTag severity={e.severity} />
        <span className="ml-auto">
          {e.confidence ? <ConfidenceBadge confidence={e.confidence} /> : null}
        </span>
      </div>
      <p>{e.text}</p>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <span className="font-mono text-[10px] text-ink-muted">{e.code}</span>
        {e.cite.map((c) => (
          <Cite key={c} id={c} />
        ))}
        {e.cite.length === 0 ? (
          <span className="text-[10px] text-ink-muted">no citation</span>
        ) : null}
      </div>
    </li>
  );
}

export function ExplainPanel() {
  const sim = useSim();
  const snapshot = useSnapshot();
  const explainSeq = useUi((s) => s.explainEvent);
  const explain = useUi((s) => s.explain);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the log grows per snapshot version
  const log = useMemo(() => [...sim.eventLog()], [sim, snapshot.version]);
  const target = explainSeq === null ? undefined : log.find((e) => e.seq === explainSeq);
  const chain = target ? causalChain(target, indexEvents(log)) : [];

  return (
    <div className="flex flex-col gap-3 px-3 py-2" data-testid="explain-panel">
      <p className="rounded-md border border-dashed border-border p-2 text-[11px] text-ink-muted">
        Placeholder: guided narratives arrive with integration. Every rule carries a citation and a
        confidence label (verified, inferred, unverified, assumption, lab-observed).
      </p>
      {target ? (
        <section aria-label="Causal chain">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
              Causal chain
            </h3>
            <button
              type="button"
              className="text-[11px] text-accent-ink hover:underline"
              onClick={() => explain(null)}
            >
              Show last tick
            </button>
          </div>
          <ol className="flex flex-col gap-1.5">
            {chain.map((e, i) => (
              <EventCard key={eventId(e)} e={e} step={i + 1} />
            ))}
          </ol>
        </section>
      ) : (
        <section aria-label="Last tick">
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            Last tick ({formatSimTime(snapshot.simTime)})
          </h3>
          {snapshot.events.length === 0 ? (
            <p className="text-xs text-ink-muted">
              Nothing happened this tick. Pick “Explain” on an event to see its chain.
            </p>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {snapshot.events.map((e) => (
                <EventCard key={eventId(e)} e={e} />
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}
