import { useSteps } from '../store/sim-context';

/** "step N" for a simulation tick: the step the run had reached then (never seconds). */
export function StepTag({ t, className }: { t: number; className?: string }) {
  const steps = useSteps();
  return (
    <span className={className ?? 'font-mono text-ink-muted'} data-testid="step-tag">
      step {steps.stepOfTick(t)}
    </span>
  );
}
