/**
 * Packet overlay (SPEC §8): one `<canvas>` over the diagram, driven by requestAnimationFrame. It
 * draws the continuous link flows (`link-flow.ts`) on wall-clock time, so dots keep a slow, steady
 * pace whether the simulation is paused, stepping or running fast, using `geometry.pointAt` and the
 * viewport from React Flow's public `getViewport()`. No React Flow internals, and nothing here
 * feeds back into the simulation.
 *
 * Drops: a new drop bursts once when its tick arrives; a persistent one (to something that is down,
 * or the same site and reason as last tick) gets a steady × instead, so a dead host's port does not
 * blink. `data-bursts` / `data-steady-drops` / `data-flows` on the canvas expose counts for tests.
 */
import { useReactFlow } from '@xyflow/react';
import { useEffect, useMemo, useRef } from 'react';
import type { Trace } from '../../engine/types';
import type { LinkGeometry, Point } from './geometry';
import { flowDotsAt, type LinkFlow } from './link-flow';
import {
  type DropContext,
  persistentDrops,
  type ReplayContext,
  steadyDropPoints,
  tracePath,
} from './replay';
import { DROP_COLOR, trafficStyle } from './traffic';

const PACKET_R = 3.6;
const STEADY_X = 3.5;
const BURST_MS = 900;

export interface PacketOverlayProps {
  readonly flows: readonly LinkFlow[];
  readonly geometry: ReadonlyMap<string, LinkGeometry>;
  /** Activity window length in ticks (stream fading). */
  readonly ticks: number;
  /** This tick's (visible) traces, for drop bursts and markers. */
  readonly traces: readonly Trace[];
  /** Changes every tick; restarts the drop bursts. */
  readonly version: number;
  readonly ctx: ReplayContext;
  /** Which drops are persistent (not news) this tick. */
  readonly drops: DropContext;
}

export function PacketOverlay({
  flows,
  geometry,
  ticks,
  traces,
  version,
  ctx,
  drops,
}: PacketOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { getViewport } = useReactFlow();
  const paths = useMemo(() => traces.map((t) => tracePath(t, ctx)), [traces, ctx]);
  const steady = useMemo(() => persistentDrops(traces, drops), [traces, drops]);
  const markers = useMemo(() => steadyDropPoints(paths, steady), [paths, steady]);
  const bursts = useMemo(() => {
    const out = new Map<string, Point>();
    traces.forEach((t, i) => {
      const p = paths[i];
      if (t.result !== 'dropped' || steady[i] || !p || p.dropU === null) return;
      const at = p.at(p.dropU);
      out.set(`${Math.round(at.x)},${Math.round(at.y)}`, at);
    });
    return [...out.values()];
  }, [traces, paths, steady]);
  const startRef = useRef(0);

  // Restart the drop bursts whenever a new snapshot arrives.
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

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = parent.clientWidth;
      const height = parent.clientHeight;
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
      for (const d of flowDotsAt(flows, geometry, now, ticks)) {
        g.globalAlpha = d.alpha;
        g.beginPath();
        g.arc(d.x, d.y, PACKET_R, 0, Math.PI * 2);
        g.fillStyle = trafficStyle(d.category).color;
        g.fill();
        g.lineWidth = 1 / zoom;
        g.strokeStyle = 'rgba(255,255,255,0.9)';
        g.stroke();
      }
      g.globalAlpha = 1;
      // Steady markers for persistent drops: drawn every frame, never animated.
      if (markers.length) {
        g.lineWidth = 2;
        g.strokeStyle = DROP_COLOR;
        for (const m of markers) cross(m.x, m.y, STEADY_X);
      }
      const progress = (now - startRef.current) / BURST_MS;
      if (progress < 0 || progress > 1) return;
      for (const b of bursts) {
        g.globalAlpha = 1 - progress * 0.8;
        g.beginPath();
        g.arc(b.x, b.y, PACKET_R + 10 * progress, 0, Math.PI * 2);
        g.lineWidth = 2;
        g.strokeStyle = DROP_COLOR;
        g.stroke();
        // An × marks the drop point, so a drop isn't conveyed by color alone.
        cross(b.x, b.y, 4);
      }
      g.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [flows, geometry, ticks, markers, bursts, getViewport]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 z-[4]"
      data-testid="packet-overlay"
      data-flows={flows.length}
      data-bursts={bursts.length}
      data-steady-drops={markers.length}
    />
  );
}
