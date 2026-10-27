/**
 * Packet overlay (SPEC §8): one `<canvas>` over the diagram, driven by requestAnimationFrame.
 * It replays the snapshot's traces over the tick's real-time window using `geometry.pointAt`
 * (via `replay.ts`) and the viewport from React Flow's public `getViewport()`. No React Flow
 * internals, and nothing here feeds back into the simulation.
 *
 * Drops: a new drop bursts once; a persistent one (to something that is down, or the same site
 * and reason as last tick) gets a steady × instead, so a dead host's port does not blink.
 * `data-bursts` / `data-steady-drops` on the canvas expose the counts for tests.
 */
import { useReactFlow } from '@xyflow/react';
import { useEffect, useMemo, useRef } from 'react';
import type { Trace } from '../../engine/types';
import {
  type DropContext,
  persistentDrops,
  type ReplayContext,
  spritesAt,
  steadyDropPoints,
  tracePath,
} from './replay';
import { DROP_COLOR, trafficStyle } from './traffic';

const PACKET_R = 3.6;
const LOOP_GAP_MS = 350;
const STEADY_X = 3.5;

export interface PacketOverlayProps {
  readonly traces: readonly Trace[];
  /** Changes every tick; restarts the replay. */
  readonly version: number;
  readonly ctx: ReplayContext;
  /** Which drops are persistent (not news) this tick. */
  readonly drops: DropContext;
  /** Real-time duration of one replay. */
  readonly windowMs: number;
  /** Loop the replay (while paused) instead of playing it once. */
  readonly loop: boolean;
}

export function PacketOverlay({ traces, version, ctx, drops, windowMs, loop }: PacketOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { getViewport } = useReactFlow();
  const paths = useMemo(() => traces.map((t) => tracePath(t, ctx)), [traces, ctx]);
  const steady = useMemo(() => persistentDrops(traces, drops), [traces, drops]);
  const markers = useMemo(() => steadyDropPoints(paths, steady), [paths, steady]);
  const bursts = traces.filter((t, i) => t.result === 'dropped' && !steady[i] && paths[i]).length;
  const startRef = useRef(0);

  // Restart the replay whenever a new snapshot arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the restart trigger
  useEffect(() => {
    startRef.current = performance.now();
  }, [version]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const g = canvas.getContext('2d');
    if (!g) return;

    let width = 0;
    let height = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      width = parent.clientWidth;
      height = parent.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(parent);

    const cross = (x: number, y: number, k: number) => {
      g.beginPath();
      g.moveTo(x - k, y - k);
      g.lineTo(x + k, y + k);
      g.moveTo(x + k, y - k);
      g.lineTo(x - k, y + k);
      g.stroke();
    };

    let raf = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, canvas.width, canvas.height);
      const { x, y, zoom } = getViewport();
      g.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * x, dpr * y);
      // Steady markers for persistent drops: drawn every frame, never animated.
      if (markers.length) {
        g.lineWidth = 2;
        g.strokeStyle = DROP_COLOR;
        for (const m of markers) cross(m.x, m.y, STEADY_X);
      }
      const elapsed = now - startRef.current;
      const phase = loop ? (elapsed % (windowMs + LOOP_GAP_MS)) / windowMs : elapsed / windowMs;
      if (phase > 1 || phase < 0) return;
      for (const s of spritesAt(traces, paths, phase, steady)) {
        if (s.kind === 'packet') {
          g.beginPath();
          g.arc(s.x, s.y, PACKET_R, 0, Math.PI * 2);
          g.fillStyle = trafficStyle(s.category).color;
          g.fill();
          g.lineWidth = 1 / zoom;
          g.strokeStyle = 'rgba(255,255,255,0.9)';
          g.stroke();
        } else {
          const r = PACKET_R + 10 * s.progress;
          g.globalAlpha = 1 - s.progress * 0.8;
          g.beginPath();
          g.arc(s.x, s.y, r, 0, Math.PI * 2);
          g.lineWidth = 2;
          g.strokeStyle = DROP_COLOR;
          g.stroke();
          // An × marks the drop point, so a drop isn't conveyed by color alone.
          cross(s.x, s.y, 4);
          g.globalAlpha = 1;
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [traces, paths, steady, markers, windowMs, loop, getViewport]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 z-[4]"
      data-testid="packet-overlay"
      data-bursts={bursts}
      data-steady-drops={markers.length}
    />
  );
}
