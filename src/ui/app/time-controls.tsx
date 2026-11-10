/**
 * Sim clock and time controls (SPEC §5.1): Step, Play/Pause with ×1/×5/×20/×60, Manual mode
 * (queue several actions without time advancing) and Fast-forward to the next timer.
 */
import { clsx } from 'clsx';
import { FastForward, Hand, Pause, Play, Square, StepForward } from 'lucide-react';
import { Button, HelpTip } from '../components/controls';
import { useSimControls, useSnapshot, useStepBusy, useSteps } from '../store/sim-context';
import { SPEEDS, useUi } from '../store/ui-store';

/**
 * The step counter. Time is shown as steps (an ordinal on a relative scale), never as seconds:
 * 0 while nothing is interrupted, then the highest step any VM's interruption has reached in the
 * current incident. Once every run has ended it reads "settled"; the next action starts again at 0.
 */
export function SimClock() {
  const steps = useSteps();
  const open = [...steps.vms.values()].filter((v) => v.startT !== null && v.resumeStep === null);
  // A VM whose process stopped (host loss, crash) is down, not merely waiting on its IO: its latest
  // vm-down comes after its latest restart or resume (an earlier run HA ended does not count).
  const down = open.some((v) => {
    const at = (stages: readonly string[]) =>
      Math.max(-1, ...v.milestones.filter((m) => stages.includes(m.stage)).map((m) => m.t));
    const downAt = at(['vm-down']);
    return downAt >= 0 && downAt > at(['ha-restarted', 'resumed']);
  });
  const note =
    steps.current === 0 && steps.settled
      ? 'steady'
      : steps.waiting
        ? 'waiting for recovery'
        : down
          ? 'VM down'
          : open.length > 0
            ? 'VM I/O interrupted'
            : steps.settled
              ? 'settled'
              : 'recovering';
  return (
    <div className="flex items-center gap-1">
      <output
        className="flex min-w-[6.5rem] flex-col rounded-md border border-border bg-panel-2 px-2 py-0.5 leading-tight"
        data-testid="sim-clock"
        data-step={steps.current}
        aria-live="off"
        aria-label={`Step ${steps.current}, ${note}`}
      >
        <span className="font-mono text-base font-semibold tabular-nums">Step {steps.current}</span>
        <span className="text-[10px] text-ink-muted">{note}</span>
      </output>
      <HelpTip id="steps-help" label="What is a step?">
        <StepsHelp />
      </HelpTip>
    </div>
  );
}

/** Text of the "What is a step?" help. */
export function StepsHelp() {
  return (
    <>
      <strong className="block font-semibold">What is a step?</strong>
      <span className="mt-1 block">
        Real failovers don't take the same number of seconds everywhere: timers, load, switch and
        array settings and software versions all change them. So the simulator shows no seconds.
      </span>
      <span className="mt-1 block">
        A step is relative timing: a slot on a scale of the time since an interruption began, each
        step about twice as long as the one before. Things that happen close together land in nearby
        steps, and a much longer wait (such as VM sessions failing back) spans only a few more.
      </span>
      <span className="mt-1 block">
        The order of events and their relative gaps come from the products' own documented timers,
        so the chain of events matches what you would see in a live environment, even where the
        exact durations differ.
      </span>
      <span className="mt-1 block text-ink-muted">
        Step 0: nothing is interrupted. Once everything has settled, the next action starts again at
        0. While what is left can only end once you recover a failed component, the counter stops
        (waiting for recovery) and picks up from the same step after you do.
      </span>
    </>
  );
}

export function TimeControls() {
  const snapshot = useSnapshot();
  const { stepForward, stopStep, fastForward } = useSimControls();
  const busy = useStepBusy();
  const playing = useUi((s) => s.playing);
  const setPlaying = useUi((s) => s.setPlaying);
  const speed = useUi((s) => s.speed);
  const setSpeed = useUi((s) => s.setSpeed);
  const manual = useUi((s) => s.manual);
  const setManual = useUi((s) => s.setManual);
  const queued = useUi((s) => s.queued);
  const next = snapshot.nextTimerAt;

  return (
    <div className="flex items-center gap-1.5" data-testid="time-controls">
      <Button
        onClick={() => stepForward()}
        disabled={playing || busy}
        aria-busy={busy}
        data-testid="step"
        data-busy={busy ? 'true' : 'false'}
        title={busy ? 'Running to the end of the step' : 'Advance to the next step'}
      >
        <StepForward size={15} aria-hidden="true" className={clsx(busy && 'animate-pulse')} />
        {busy ? 'Stepping…' : 'Step'}
      </Button>
      {/* A late step can take a while to run: stop the press where it is. */}
      {busy ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            stopStep();
            // The Stop button goes away: keep keyboard focus on Step (enabled again next frame).
            requestAnimationFrame(() =>
              document.querySelector<HTMLButtonElement>('[data-testid="step"]')?.focus(),
            );
          }}
          data-testid="step-stop"
          title="Stop this step here"
        >
          <Square size={12} aria-hidden="true" />
          Stop
        </Button>
      ) : null}
      <Button
        variant={playing ? 'primary' : 'default'}
        aria-pressed={playing}
        onClick={() => setPlaying(!playing)}
        disabled={manual}
        data-testid="play"
        title={manual ? 'Turn off manual mode to play' : undefined}
      >
        {playing ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
        {playing ? 'Pause' : 'Play'}
      </Button>
      <fieldset
        className="flex overflow-hidden rounded-md border border-border"
        aria-label="Playback speed"
      >
        <legend className="sr-only">Playback speed</legend>
        {SPEEDS.map((s) => (
          <label
            key={s}
            className={clsx(
              'cursor-pointer px-1.5 py-1 font-mono text-xs has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus',
              speed === s ? 'bg-accent text-on-accent' : 'bg-panel-2 text-ink-muted hover:bg-hover',
            )}
          >
            <input
              type="radio"
              name="speed"
              value={s}
              checked={speed === s}
              onChange={() => setSpeed(s)}
              className="sr-only"
              data-testid={`speed-${s}`}
            />
            ×{s}
          </label>
        ))}
      </fieldset>
      <Button
        aria-pressed={manual}
        variant={manual ? 'primary' : 'default'}
        onClick={() => setManual(!manual)}
        data-testid="manual"
        title="Manual mode: queue several actions; time only advances when you Step"
      >
        <Hand size={15} aria-hidden="true" />
        Manual
        {manual && queued > 0 ? (
          <span
            className="rounded-full bg-on-accent/90 px-1.5 text-[10px] text-accent-ink"
            data-testid="queued"
          >
            {queued} queued
          </span>
        ) : null}
      </Button>
      <Button
        onClick={fastForward}
        disabled={playing || next === null}
        data-testid="fast-forward"
        title={next === null ? 'Nothing pending' : 'Run until the next scheduled event fires'}
      >
        <FastForward size={15} aria-hidden="true" />
        Next event
      </Button>
    </div>
  );
}
