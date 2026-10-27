import { t1Steady } from '../../fixtures/snapshots/t1-steady';

/** Phase 0 shell. Stream B replaces the body with the diagram + panels (SPEC §8). */
export function App() {
  const snapshot = t1Steady;
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-panel px-4 py-2">
        <h1 className="text-lg font-semibold">
          NutanixVis{' '}
          <span className="font-normal text-ink-muted">· failure scenario simulator</span>
        </h1>
        <span className="font-mono text-sm text-ink-muted" data-testid="sim-clock">
          T+{snapshot.simTime}s
        </span>
      </header>
      <main className="flex-1 p-4">
        <p className="text-ink-muted">
          Fixture snapshot: {Object.keys(snapshot.devices).length} devices,{' '}
          {Object.keys(snapshot.links).length} links.
        </p>
      </main>
    </div>
  );
}
