/**
 * Scenario tab: guided scenarios from `src/scenarios` (SPEC §7). Picking one loads its topology and
 * options into the diagram; its timeline is applied by hand, one group at a time. After each group
 * the panel lists what to watch for (the scenario's `guide`, held to the run by its own test), with
 * a Step button in the flow; each observation is ticked off live when the VM's steps show it. Only
 * the steps-view scenarios are offered: their text speaks in steps, never in durations.
 */
import { clsx } from 'clsx';
import { Circle, CircleCheck, Info, StepForward } from 'lucide-react';
import { useMemo, useState } from 'react';
import { deriveArrayOpSteps, deriveVmSteps } from '../../domain/steps';
import { scenarios } from '../../scenarios';
import type { GuideObservation, ScenarioDef } from '../../scenarios/define';
import { Button, Select } from '../components/controls';
import { useSim, useSimControls, useSnapshot, useSteps } from '../store/sim-context';
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

interface Observed {
  readonly stages: ReadonlySet<string>;
  /** When each stall or VM-down began (a "no new stall" note is judged from its group on). */
  readonly troubleAt: readonly number[];
}

const NOTHING: Observed = { stages: new Set(), troubleAt: [] };

/** Stages the guided VM has reached since the scenario's first group was applied. */
function useObservedStages(vm: string | null, from: number | null): Observed {
  const steps = useSteps();
  const sim = useSim();
  return useMemo(() => {
    if (vm === null || from === null) return NOTHING;
    const samples = (steps.samples.get(vm) ?? []).filter((x) => x.t >= from);
    const events = sim.eventLog();
    const r = deriveVmSteps(vm, events, samples);
    // A planned array operation (controller reboot, NDU) has stages of its own.
    const op = deriveArrayOpSteps(events, from);
    const all = [...r.milestones, ...op.milestones];
    return {
      stages: new Set(all.map((m) => m.stage)),
      troubleAt: all.filter((m) => m.stage === 'stall' || m.stage === 'vm-down').map((m) => m.t),
    };
  }, [steps, sim, vm, from]);
}

function Observations({
  items,
  observed,
  quiet,
}: {
  items: readonly GuideObservation[];
  observed: ReadonlySet<string>;
  /** Time has run since the group was applied and the guided VM never stalled. */
  quiet: boolean;
}) {
  return (
    <ul className="mt-1.5 flex flex-col gap-1" aria-label="Expected observations">
      {items.map((o) => {
        // A "no IO stalls" note (no stage of its own) is borne out once time has run without one.
        const tracked = o.stage !== undefined || o.io === 'none';
        const seen = o.stage !== undefined ? observed.has(o.stage) : o.io === 'none' && quiet;
        return (
          <li
            key={o.text}
            className={clsx('flex items-start gap-1.5', seen ? 'text-ink' : 'text-ink-muted')}
            data-testid="scenario-observation"
            data-seen={seen ? 'yes' : 'no'}
            {...(o.stage ? { 'data-stage': o.stage } : {})}
          >
            {!tracked ? (
              <Info size={12} aria-hidden="true" className="mt-px shrink-0" />
            ) : seen ? (
              <CircleCheck
                size={12}
                aria-label="observed"
                className="mt-px shrink-0 text-status-healthy"
              />
            ) : (
              <Circle size={12} aria-label="not yet" className="mt-px shrink-0" />
            )}
            <span className="flex-1">{o.text}</span>
            {o.step !== undefined ? (
              <span className="shrink-0 rounded border border-border px-1 text-[10px] tabular-nums">
                step {o.step}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function ActiveScenario({ def }: { def: ScenarioDef }) {
  const { apply, stepForward } = useSimControls();
  const sim = useSim();
  const current = useSteps().current;
  const simEpoch = useUi((s) => s.simEpoch);
  const groups = useMemo(() => timelineGroups(def), [def]);
  const now = useSnapshot().simTime;
  const [applied, setApplied] = useState<{
    epoch: number;
    n: number;
    from: number | null;
    /** Sim time each group was applied at. */
    times: readonly number[];
  }>({
    epoch: simEpoch,
    n: 0,
    from: null,
    times: [],
  });
  // A rebuilt simulation (reset) starts the timeline again.
  const fresh = applied.epoch === simEpoch;
  const done = fresh ? applied.n : 0;
  const observed = useObservedStages(def.guide?.vm ?? null, fresh ? applied.from : null);
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
          const items = def.guide?.groups[i] ?? [];
          const latest = i === done - 1;
          return (
            <li
              key={g[0]?.at}
              className="rounded-md border border-border bg-panel-2 p-2 text-xs"
              data-testid="scenario-group"
              data-state={state}
            >
              <div className="flex items-center gap-2">
                <span className="flex-1">
                  <span className="font-semibold">{i === 0 ? 'Failure' : 'Then'}</span>
                  {note ? `: ${note}` : `: ${g.length} change${g.length === 1 ? '' : 's'}`}
                </span>
                <Button
                  size="sm"
                  disabled={state !== 'next'}
                  data-testid={`scenario-apply-${i}`}
                  onClick={() => {
                    // Observations are read from the first group on (the scenario's own run).
                    const from =
                      fresh && applied.from !== null ? applied.from : sim.getSnapshot().simTime;
                    const at = sim.getSnapshot().simTime;
                    for (const s of g) apply(s.action);
                    setApplied({
                      epoch: simEpoch,
                      n: i + 1,
                      from,
                      times: [...(fresh ? applied.times : []), at],
                    });
                  }}
                >
                  {state === 'applied' ? 'Applied' : i === 0 ? 'Inject' : 'Apply'}
                </Button>
              </div>
              {items.length > 0 ? (
                <>
                  <p className="mt-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                    {state === 'applied' ? 'Watch for' : 'You will see'}
                  </p>
                  <Observations
                    items={items}
                    observed={state === 'applied' ? observed.stages : new Set()}
                    quiet={
                      state === 'applied' &&
                      now > (applied.times[i] ?? Number.POSITIVE_INFINITY) &&
                      !observed.troubleAt.some((t) => t >= (applied.times[i] ?? 0))
                    }
                  />
                </>
              ) : null}
              {latest ? (
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    data-testid={`scenario-step-${i}`}
                    onClick={stepForward}
                  >
                    <StepForward size={12} aria-hidden="true" /> Step
                  </Button>
                  <span className="text-ink-muted" data-testid="scenario-step-now">
                    now at step {current}
                  </span>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
