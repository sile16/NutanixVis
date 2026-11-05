/**
 * Throughput-model controls in the header (T1 only, docs/research/link-congestion.md):
 * - an IOPS-per-VM slider that sets every VM's offered load (`workload.set-iops`; IO size from
 *   the model, so the Gb/s it means is shown next to it). The right end is line rate (no cap).
 * - a toggle for the ↓/↑ Gb/s labels on cables (the line-rate and distribution bars stay).
 */
import { Gauge } from 'lucide-react';
import { useEffect, useState } from 'react';
import { THROUGHPUT } from '../../domain/workload/io';
import { Button } from '../components/controls';
import { useSimControls, useSnapshot } from '../store/sim-context';
import { useUi } from '../store/ui-store';

/** Slider stops, IOPS per VM; `0` = line rate (no cap). */
export const IOPS_STOPS = [1000, 2000, 5000, 10000, 20000, 30000, 40000, 50000, 70000, 0] as const;

const IO_BITS = THROUGHPUT.ioSizeKiB.value * 1024 * 8;
const fmtIops = (n: number) => (n >= 1000 ? `${n / 1000}k` : String(n));

export function WorkloadControls() {
  const snapshot = useSnapshot();
  const { apply } = useSimControls();
  const showSpeeds = useUi((s) => s.showSpeeds);
  const setShowSpeeds = useUi((s) => s.setShowSpeeds);
  const hasModel = snapshot.devices.flows !== undefined;
  // Start from what the VMs offer now (all VMs share the slider's value once it is used).
  const current = Object.values(snapshot.devices).find(
    (d) => d.kind === 'vm' && d.fields.offeredIops !== undefined,
  )?.fields.offeredIops;
  const fromSim =
    current === 'line-rate' || current === undefined
      ? IOPS_STOPS.length - 1
      : nearest(Number(current));
  const [index, setIndex] = useState(fromSim);
  useEffect(() => setIndex(fromSim), [fromSim]);
  if (!hasModel) return null;
  const iops = IOPS_STOPS[index] ?? 0;
  const commit = () => {
    if (index === fromSim) return;
    apply({ kind: 'workload.set-iops', target: 'cluster', params: { iops } });
  };
  const gbps = (iops * IO_BITS) / 1e9;
  return (
    <div className="flex items-center gap-2 self-center" data-testid="workload-controls">
      <label className="flex flex-col text-[11px] leading-tight text-ink-muted">
        <span>
          IOPS per VM:{' '}
          <span className="font-mono text-ink" data-testid="iops-value">
            {iops === 0
              ? 'line rate'
              : `${fmtIops(iops)} · ${gbps < 10 ? gbps.toFixed(1) : Math.round(gbps)} Gb/s`}
          </span>
        </span>
        <input
          type="range"
          min={0}
          max={IOPS_STOPS.length - 1}
          step={1}
          value={index}
          onChange={(e) => setIndex(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          className="w-40 accent-accent"
          aria-label="IOPS per VM"
          title={`Every VM offers this many ${THROUGHPUT.ioSizeKiB.value} KiB IOs per second (illustrative workload); the right end is line rate`}
          data-testid="iops-slider"
        />
      </label>
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={showSpeeds}
        onClick={() => setShowSpeeds(!showSpeeds)}
        title="Show or hide the ↓/↑ Gb/s labels on cables"
        data-testid="toggle-speeds"
      >
        <Gauge size={14} aria-hidden="true" />
        {showSpeeds ? 'Hide speeds' : 'Show speeds'}
      </Button>
    </div>
  );
}

function nearest(iops: number): number {
  let best = 0;
  IOPS_STOPS.forEach((s, i) => {
    if (s !== 0 && Math.abs(s - iops) < Math.abs((IOPS_STOPS[best] ?? 0) - iops)) best = i;
  });
  return best;
}
