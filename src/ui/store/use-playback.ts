import { useEffect } from 'react';
import { playbackSchedule } from './playback';
import { useSimControls } from './sim-context';
import { useUi } from './ui-store';

/** Drives auto-step while `playing`; returns nothing. Mount once under the SimProvider. */
export function usePlayback(): void {
  const playing = useUi((s) => s.playing);
  const speed = useUi((s) => s.speed);
  const { step } = useSimControls();
  useEffect(() => {
    if (!playing) return;
    const { intervalMs, ticksPerInterval } = playbackSchedule(speed);
    const handle = window.setInterval(() => step(ticksPerInterval), intervalMs);
    return () => window.clearInterval(handle);
  }, [playing, speed, step]);
}
