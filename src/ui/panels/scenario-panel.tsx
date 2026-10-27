/** Scenario tab (placeholder): guided scenarios from `src/scenarios` arrive with integration. */
export function ScenarioPanel() {
  return (
    <div className="px-3 py-2 text-sm text-ink-muted" data-testid="scenario-panel">
      <p className="mb-2">
        Guided scenarios will walk through a failure step by step: set up the topology, inject the
        failure, then watch each timer fire with its explanation and source.
      </p>
      <p className="rounded-md border border-dashed border-border p-2 text-[11px]">
        Placeholder. Until then, use the Inspector actions or right-click a device or cable.
      </p>
    </div>
  );
}
