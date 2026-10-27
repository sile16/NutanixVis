/**
 * App shell (SPEC §8): header (brand, topology picker, version selector, clock, time controls),
 * the diagram in the centre and the tabbed right rail.
 *
 * Topologies come from `src/topologies` via the loader (`./catalog`), plus fixture demo entries
 * with scripted traffic; versions come from the real version matrix.
 */
import { Eye, EyeOff, Monitor, Moon, Move, RotateCcw, Sun } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { matrix as versionMatrix } from '../../domain/versions';
import type { CatalogEntry } from '../../fixtures/catalog';
import { VendorLogo } from '../components/brand';
import { Button, Select } from '../components/controls';
import { Diagram } from '../diagram/diagram';
import { RightRail } from '../panels/right-rail';
import { SimProvider } from '../store/sim-context';
import { type ThemePref, topologyFromHash, useUi } from '../store/ui-store';
import { usePlayback } from '../store/use-playback';
import { catalog } from './catalog';
import { loadThemePref, saveThemePref, useResolvedTheme } from './theme';
import { SimClock, TimeControls } from './time-controls';
import { VersionSelector } from './version-selector';
import { resolveVersions, toVersionSelection } from './versions';

const matrix = versionMatrix;
const THEME_NEXT: Readonly<Record<ThemePref, ThemePref>> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
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
      if (id && id !== useUi.getState().topologyId && catalog.some((t) => t.id === id)) {
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

function ThemeToggle({ pref }: { pref: ThemePref }) {
  const setTheme = useUi((s) => s.setTheme);
  const Icon = pref === 'light' ? Sun : pref === 'dark' ? Moon : Monitor;
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        const next = THEME_NEXT[pref];
        setTheme(next);
        saveThemePref(next);
      }}
      aria-label={`Theme: ${pref}. Switch to ${THEME_NEXT[pref]}`}
      title={`Theme: ${pref}`}
    >
      <Icon size={15} aria-hidden="true" />
    </Button>
  );
}

function Header({ entry, themePref }: { entry: CatalogEntry; themePref: ThemePref }) {
  const setTopology = useUi((s) => s.setTopology);
  const resetSim = useUi((s) => s.resetSim);
  const showPackets = useUi((s) => s.showPackets);
  const togglePackets = useUi((s) => s.togglePackets);
  const activityTicks = useUi((s) => s.activityTicks);
  const setActivityTicks = useUi((s) => s.setActivityTicks);
  const layoutEdit = useUi((s) => s.layoutEdit);
  const setLayoutEdit = useUi((s) => s.setLayoutEdit);
  return (
    <header className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-border bg-panel px-4 py-2">
      <div className="mr-2 self-center">
        <h1 className="text-lg font-bold leading-tight tracking-tight">NutanixVis</h1>
        <p className="flex items-center gap-1.5 text-[11px] leading-tight text-ink-muted">
          Failure scenario simulator for
          <VendorLogo vendor="nutanix" height={10} />
          <span aria-hidden="true">+</span>
          <VendorLogo vendor="everpure" height={12} />
        </p>
      </div>
      <Select
        label="Topology"
        value={entry.id}
        onChange={(e) => setTopology(e.target.value)}
        data-testid="topology-select"
      >
        {catalog.map((t) => (
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
      <div className="ml-auto flex items-center gap-1 self-center">
        <Button variant="ghost" size="sm" onClick={resetSim} title="Reset the simulation">
          <RotateCcw size={15} aria-hidden="true" />
          <span className="sr-only">Reset simulation</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={showPackets}
          onClick={togglePackets}
          data-testid="toggle-packets"
          title={showPackets ? 'Hide packet animation' : 'Show packet animation'}
        >
          {showPackets ? (
            <Eye size={15} aria-hidden="true" />
          ) : (
            <EyeOff size={15} aria-hidden="true" />
          )}
          Packets
        </Button>
        <Select
          label="Activity"
          value={String(activityTicks)}
          onChange={(e) => setActivityTicks(Number(e.target.value))}
          data-testid="activity-window"
          title="How many recent ticks the cable glow, path highlight and bond shares aggregate"
        >
          {[1, 5, 10, 30].map((n) => (
            <option key={n} value={n}>
              {n === 1 ? 'Last tick' : `Last ${n} ticks`}
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
        <ThemeToggle pref={themePref} />
      </div>
    </header>
  );
}

export function App() {
  const topologyId = useUi((s) => s.topologyId);
  const versions = useUi((s) => s.versions);
  const simEpoch = useUi((s) => s.simEpoch);
  const themePref = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  useEffect(() => setTheme(loadThemePref()), [setTheme]);
  const theme = useResolvedTheme(themePref);

  const entry = catalog.find((t) => t.id === topologyId) ?? catalog[0];
  if (!entry) throw new Error('fixture catalog is empty');
  useTopologyHash(entry.id);
  const resolved = resolveVersions(matrix, versions);
  const selection = toVersionSelection(matrix, resolved, entry.hasFlashArray);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuild on topology/version/reset only
  const sim = useMemo(
    () => entry.createSimulation(selection),
    [entry, selection.nutanix, selection.flasharray, simEpoch],
  );

  return (
    <SimProvider sim={sim}>
      <PlaybackDriver />
      <div className="flex h-full flex-col">
        <Header entry={entry} themePref={themePref} />
        <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_24rem]">
          <section aria-label="Topology diagram" className="min-h-0 min-w-0">
            <Diagram key={`${entry.id}:${simEpoch}`} baseLayout={entry.layout} colorMode={theme} />
          </section>
          <aside aria-label="Details" className="min-h-0 border-l border-border bg-panel">
            <RightRail />
          </aside>
        </main>
      </div>
    </SimProvider>
  );
}
