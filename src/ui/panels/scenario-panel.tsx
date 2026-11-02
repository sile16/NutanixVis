/**
 * Scenario tab: guided scenarios from `src/scenarios` (SPEC §7). Picking one loads its topology and
 * options into the diagram; its timeline is applied by hand, one group at a time, so the user
 * watches each step before the next change. Only the steps-view scenarios are offered: their text
 * speaks in steps, never in durations.
 */
import { useMemo, useState } from 'react';
import { scenarios } from '../../scenarios';
import type { ScenarioDef } from '../../scenarios/define';
import { Button, Select } from '../components/controls';
import { useSimControls } from '../store/sim-context';
import { useUi } from '../store/ui-store';

/** The scenario name without its "T1" / "T1 steps:" prefix, first letter capitalised. */
export function displayTitle(title: string): string {
  const t = title.replace(/^T1 (steps: )?/, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export const isGuided = (s: ScenarioDef): boolean =>
  s.status === 'active' && s.id.includes('-steps-');

/** Timeline entries grouped by their (internal) time, in order. */
export function timelineGroups(s: ScenarioDef): ScenarioDef['timeline'][number][][] {
  const out: ScenarioDef['timeline'][number][][] = [];
  let at: number | null = null;
  for (const step of [...s.timeline].sort((a, b) => a.at - b.at)) {
    if (step.at !== at) out.push([]);
    at = step.at;
    out[out.length - 1]?.push(step);
  }
  return out;
}

export function ScenarioPanel() {
  const scenarioId = useUi((s) => s.scenarioId);
  const loadScenario = useUi((s) => s.loadScenario);
  const topologyId = useUi((s) => s.topologyId);
  const guided = useMemo(() => scenarios.filter(isGuided), []);
  const active = guided.find((s) => s.id === scenarioId) ?? null;

  return (
    <div className="flex flex-col gap-3 px-3 py-2 text-sm" data-testid="scenario-panel">
      <Select
        label="Guided scenario"
        value={active?.id ?? ''}
        onChange={(e) => {
          const next = guided.find((s) => s.id === e.target.value);
          loadScenario(next?.id ?? null, next?.topology ?? topologyId);
        }}
        data-testid="scenario-select"
      >
        <option value="">Free play (use the Inspector)</option>
        {guided.map((s) => (
          <option key={s.id} value={s.id}>
            {displayTitle(s.title)}
          </option>
        ))}
      </Select>
      {active ? (
        <ActiveScenario key={`${active.id}`} def={active} />
      ) : (
        <p className="text-xs text-ink-muted">
          Pick a scenario to load its topology, then apply its failure and watch each step. Time is
          shown as steps: an ordinal on a relative scale, not a duration.
        </p>
      )}
    </div>
  );
}

function ActiveScenario({ def }: { def: ScenarioDef }) {
  const { apply } = useSimControls();
  const simEpoch = useUi((s) => s.simEpoch);
  const groups = useMemo(() => timelineGroups(def), [def]);
  const [applied, setApplied] = useState<{ epoch: number; n: number }>({ epoch: simEpoch, n: 0 });
  // A rebuilt simulation (reset) starts the timeline again.
  const done = applied.epoch === simEpoch ? applied.n : 0;
  return (
    <section aria-label="Scenario" className="flex flex-col gap-2" data-testid="scenario-active">
      <p className="text-xs">{def.narrative}</p>
      <ol className="flex flex-col gap-1.5">
        {groups.map((g, i) => {
          const note = g
            .map((x) => x.note)
            .filter(Boolean)
            .join(' ');
          const state = i < done ? 'applied' : i === done ? 'next' : 'later';
          return (
            <li
              key={g[0]?.at}
              className="flex items-center gap-2 rounded-md border border-border bg-panel-2 p-2 text-xs"
              data-testid="scenario-group"
              data-state={state}
            >
              <span className="flex-1">
                <span className="font-semibold">{i === 0 ? 'Failure' : 'Then'}</span>
                {note ? `: ${note}` : `: ${g.length} change${g.length === 1 ? '' : 's'}`}
              </span>
              <Button
                size="sm"
                disabled={state !== 'next'}
                data-testid={`scenario-apply-${i}`}
                onClick={() => {
                  for (const s of g) apply(s.action);
                  setApplied({ epoch: simEpoch, n: i + 1 });
                }}
              >
                {state === 'applied' ? 'Applied' : i === 0 ? 'Inject' : 'Apply'}
              </Button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
