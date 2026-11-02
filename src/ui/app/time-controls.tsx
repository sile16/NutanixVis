/**
 * Sim clock and time controls (SPEC §5.1): Step, Play/Pause with ×1/×5/×20/×60, Manual mode
 * (queue several actions without time advancing) and Fast-forward to the next timer.
 */
import { clsx } from 'clsx';
import { FastForward, Hand, Pause, Play, StepForward } from 'lucide-react';
import { Button } from '../components/controls';
import { useSimControls, useSnapshot, useSteps } from '../store/sim-context';
import { SPEEDS, useUi } from '../store/ui-store';

/**
 * The step counter. Time is shown as steps (an ordinal on a relative scale), never as seconds:
 * 0 while nothing is interrupted, then the highest step any VM's interruption has reached.
 */
export function SimClock() {
  const steps = useSteps();
  const stalled = [...steps.vms.values()].filter(
    (v) => v.stalledSteps > 0 || v.resumeStep === null,
  );
  const note =
    steps.current === 0
      ? 'steady'
      : stalled.some((v) => v.resumeStep === null)
        ? 'VM I/O interrupted'
        : 'recovering';
  return (
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
  );
}

export function TimeControls() {
  const snapshot = useSnapshot();
  const { stepForward, fastForward } = useSimControls();
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
        disabled={playing}
        data-testid="step"
        title="Advance to the next step"
      >
        <StepForward size={15} aria-hidden="true" />
        Step
      </Button>
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
