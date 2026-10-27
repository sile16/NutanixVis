/**
 * Playback schedule (pure). At ×1 one tick is one real second. Faster speeds batch several ticks
 * per interval so the UI never re-renders faster than `MIN_INTERVAL_MS`; the packet overlay
 * replays the last tick over the interval.
 */
export const MIN_INTERVAL_MS = 200;
/** Replay window used while paused (the last tick loops so traffic stays visible). */
export const PAUSED_REPLAY_MS = 1600;

export function playbackSchedule(speed: number): { intervalMs: number; ticksPerInterval: number } {
  const perTick = 1000 / Math.max(speed, 1);
  if (perTick >= MIN_INTERVAL_MS) return { intervalMs: perTick, ticksPerInterval: 1 };
  const ticksPerInterval = Math.round(MIN_INTERVAL_MS / perTick);
  return { intervalMs: ticksPerInterval * perTick, ticksPerInterval };
}
