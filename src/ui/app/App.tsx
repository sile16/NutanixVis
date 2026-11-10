/**
 * App shell (SPEC §8): header (brand, topology picker, version selector, clock, time controls),
 * the diagram in the centre and the tabbed right rail.
 *
 * Topologies come from `src/topologies` via the loader (`./catalog`), plus fixture demo entries
 * with scripted traffic; versions come from the real version matrix.
 */
import { Move, RotateCcw } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { matrix as versionMatrix } from '../../domain/versions';
import type { CatalogEntry } from '../../fixtures/catalog';
import { getScenario } from '../../scenarios';
import { VendorLogo } from '../components/brand';
import { Button, Select } from '../components/controls';
import { Diagram } from '../diagram/diagram';
import { RightRail } from '../panels/right-rail';
import { ImpactStrip } from '../steps/impact-strip';
import { SimProvider } from '../store/sim-context';
import { topologyFromHash, useUi } from '../store/ui-store';
import { usePlayback } from '../store/use-playback';
import { catalog, fullCatalog, scenarioEntry, scenarioTopologyTitle } from './catalog';
import { useDarkTheme } from './theme';
import { SimClock, TimeControls } from './time-controls';
import { VersionSelector } from './version-selector';
import { resolveVersions, toVersionSelection } from './versions';
import { WorkloadControls } from './workload-controls';

const matrix = versionMatrix;
/** Activity windows are named by relative size, not by duration. */
const ACTIVITY_LABEL: Readonly<Record<number, string>> = {
  1: 'Latest only',
  5: 'Short',
  10: 'Medium',
  30: 'Long',
};
/**
 * Keep `#topology=<id>` and the selected topology in sync both ways: picking a topology writes the
 * hash (so reload and shared links keep it), and editing the hash or going back switches.
 */
function useTopologyHash(topologyId: string) {
  const setTopology = useUi((s) => s.setTopology);
  useEffect(() => {
    if (topologyFromHash(window.location.hash) === topologyId) return;
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    params.set('topology', topologyId);
    window.history.replaceState(null, '', `#${params.toString()}`);
  }, [topologyId]);
  useEffect(() => {
    const onHash = () => {
      const id = topologyFromHash(window.location.hash);
      if (id && id !== useUi.getState().topologyId && fullCatalog.some((t) => t.id === id)) {
        setTopology(id);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [setTopology]);
}

function PlaybackDriver() {
  usePlayback();
  return null;
}

/** Topology menu value while a guided scenario's own build is loaded. */
const SCENARIO_VALUE = '__scenario__';

function Header({ entry }: { entry: CatalogEntry }) {
  const setTopology = useUi((s) => s.setTopology);
  const scenarioId = useUi((s) => s.scenarioId);
  const scenarioTitle = scenarioId
    ? (scenarioTopologyTitle(getScenario(scenarioId)) ?? entry.title)
    : null;
  const resetSim = useUi((s) => s.resetSim);
  const activityTicks = useUi((s) => s.activityTicks);
  const setActivityTicks = useUi((s) => s.setActivityTicks);
  const layoutEdit = useUi((s) => s.layoutEdit);
  const setLayoutEdit = useUi((s) => s.setLayoutEdit);
  return (
    <header className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-border bg-panel px-4 py-2">
      {/* Keyboard users would otherwise tab through every cable before reaching the panel. */}
      <button
        type="button"
        className="sr-only rounded bg-accent px-2 py-1 text-xs text-white focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50"
        data-testid="skip-to-panel"
        onClick={() => document.getElementById('side-panel')?.focus()}
      >
        Skip to side panel
      </button>
      <div className="mr-2 self-center">
        <h1 className="text-lg font-bold leading-tight tracking-tight">
          NutanixVis{' '}
          <span
            className="text-[11px] font-normal text-ink-muted"
            data-testid="build-version"
            title={`Build ${__BUILD_ID__}, ${__BUILD_DATE__}`}
          >
            {__BUILD_ID__} · {__BUILD_DATE__}
          </span>
        </h1>
        <p className="flex items-center gap-1.5 text-[11px] leading-tight text-ink-muted">
          Failure scenario simulator for
          <VendorLogo vendor="nutanix" height={10} />
          <span aria-hidden="true">+</span>
          <VendorLogo vendor="everpure" height={12} />
        </p>
      </div>
      <Select
        label="Topology"
        value={scenarioTitle === null ? entry.id : SCENARIO_VALUE}
        onChange={(e) => {
          if (e.target.value !== SCENARIO_VALUE) setTopology(e.target.value);
        }}
        data-testid="topology-select"
      >
        {/* A guided scenario builds its own options: name them, not the menu entry it shares an id with. */}
        {scenarioTitle !== null ? (
          <option value={SCENARIO_VALUE}>Scenario: {scenarioTitle}</option>
        ) : null}
        {(catalog.some((t) => t.id === entry.id) ? catalog : [...catalog, entry]).map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
          </option>
        ))}
      </Select>
      <VersionSelector matrix={matrix} hasFlashArray={entry.hasFlashArray} />
      <div className="flex items-end gap-2">
        <SimClock />
        <TimeControls />
      </div>
      <WorkloadControls />
      <div className="ml-auto flex items-center gap-1 self-center">
        <Button variant="ghost" size="sm" onClick={resetSim} title="Reset the simulation">
          <RotateCcw size={15} aria-hidden="true" />
          <span className="sr-only">Reset simulation</span>
        </Button>
        <Select
          label="Recent activity"
          value={String(activityTicks)}
          onChange={(e) => setActivityTicks(Number(e.target.value))}
          data-testid="activity-window"
          title="How much recent activity the cable glow, path highlight and bond shares aggregate"
        >
          {[1, 5, 10, 30].map((n) => (
            <option key={n} value={n}>
              {ACTIVITY_LABEL[n] ?? `Window ${n}`}
            </option>
          ))}
        </Select>
        {import.meta.env.DEV ? (
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={layoutEdit}
            onClick={() => setLayoutEdit(!layoutEdit)}
            title="Dev only: drag nodes and copy layout JSON"
          >
            <Move size={15} aria-hidden="true" />
            Layout
          </Button>
        ) : null}
      </div>
    </header>
  );
}

export function App() {
  const topologyId = useUi((s) => s.topologyId);
  const versions = useUi((s) => s.versions);
  const simEpoch = useUi((s) => s.simEpoch);
  useDarkTheme();

  const scenarioId = useUi((s) => s.scenarioId);
  const entry = useMemo(
    () =>
      scenarioId
        ? scenarioEntry(getScenario(scenarioId))
        : (fullCatalog.find((t) => t.id === topologyId) ?? catalog[0]),
    [scenarioId, topologyId],
  );
  if (!entry) throw new Error('fixture catalog is empty');
  useTopologyHash(entry.id);
  const resolved = resolveVersions(matrix, versions);
  const selection = toVersionSelection(matrix, resolved, entry.hasFlashArray);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuild on topology/version/reset only
  const sim = useMemo(() => {
    const created = entry.createSimulation(selection);
    // Steady-state IO is already flowing when the page loads: run the first tick so the
    // first frame carries traffic. It is not a step; the step counter still starts at 0.
    created.tick(1);
    return created;
  }, [entry.id, scenarioId, selection.nutanix, selection.flasharray, simEpoch]);

  return (
    <SimProvider sim={sim}>
      <PlaybackDriver />
      <div className="flex h-full flex-col">
        <Header entry={entry} />
        <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_24rem]">
          <section aria-label="Topology diagram" className="flex min-h-0 min-w-0 flex-col">
            <div className="min-h-0 flex-1">
              <Diagram key={`${entry.id}:${simEpoch}`} baseLayout={entry.layout} colorMode="dark" />
            </div>
            {entry.hasFlashArray ? <ImpactStrip /> : null}
          </section>
          <aside
            id="side-panel"
            tabIndex={-1}
            aria-label="Details"
            className="min-h-0 border-l border-border bg-panel focus:outline-none"
          >
            <RightRail />
          </aside>
        </main>
      </div>
    </SimProvider>
  );
}
