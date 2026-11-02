/**
 * UI-only state (SPEC §3): selection, playback speed, open tab, manual mode, view toggles.
 * Simulation state never lives here; it comes from `Simulation` snapshots (see `use-sim.ts`).
 */
import { create } from 'zustand';
import {
  parseTrafficFilter,
  presetFilter,
  type TrafficFilter,
  type TrafficPreset,
  toggleCategory,
} from '../diagram/traffic';

// Session storage: the choice lasts for the session; a new session starts at storage I/O only.
const TRAFFIC_KEY = 'nutanixvis.traffic.session';

function loadTrafficFilter(): TrafficFilter {
  try {
    return parseTrafficFilter(window.sessionStorage.getItem(TRAFFIC_KEY));
  } catch {
    return parseTrafficFilter(null);
  }
}

function saveTrafficFilter(f: TrafficFilter): TrafficFilter {
  try {
    window.sessionStorage.setItem(TRAFFIC_KEY, JSON.stringify(f));
  } catch {
    // storage unavailable (private mode): the choice lasts for this page only
  }
  return f;
}

export type Selection =
  | { readonly type: 'device'; readonly id: string }
  | { readonly type: 'link'; readonly id: string };

export const SPEEDS = [1, 5, 20, 60] as const;
export type Speed = (typeof SPEEDS)[number];

export type RailTab = 'inspector' | 'events' | 'scenario';

export interface VersionChoice {
  readonly nutanix: string;
  readonly flasharray: string | undefined;
}

export interface UiState {
  topologyId: string;
  /** Guided scenario loaded into the diagram (its topology and options), or null for free play. */
  scenarioId: string | null;
  versions: VersionChoice;
  /** Bumped to rebuild the simulation (reset). */
  simEpoch: number;
  selection: Selection | null;
  hoveredLink: { id: string; x: number; y: number } | null;
  contextMenu: { target: Selection; x: number; y: number } | null;
  tab: RailTab;
  speed: Speed;
  playing: boolean;
  manual: boolean;
  /** Actions queued since the last tick (shown in manual mode). */
  queued: number;
  /** Actions applied since the simulation was (re)built: changing versions asks first. */
  actionsApplied: number;
  /** Ticks of history the diagram's activity views (glow, paths, bond shares) aggregate. */
  activityTicks: number;
  /** Host whose bond member utilization is shown on the diagram. */
  bondUtilHost: string | null;
  layoutEdit: boolean;
  /** Which traffic categories the overlay, glow and hover card show (kept across topologies). */
  traffic: TrafficFilter;

  select(sel: Selection | null): void;
  setHoveredLink(h: UiState['hoveredLink']): void;
  openContextMenu(m: UiState['contextMenu']): void;
  setTab(tab: RailTab): void;
  setSpeed(speed: Speed): void;
  setPlaying(playing: boolean): void;
  setManual(manual: boolean): void;
  noteActionQueued(): void;
  noteTicked(): void;
  setTopology(id: string): void;
  loadScenario(id: string | null, topology?: string): void;
  setVersions(v: VersionChoice): void;
  resetSim(): void;
  setActivityTicks(n: number): void;
  setBondUtilHost(id: string | null): void;
  setLayoutEdit(on: boolean): void;
  toggleTraffic(category: string): void;
  setTrafficPreset(preset: TrafficPreset): void;
}

const DEFAULT_TOPOLOGY = 't1-ahv-flasharray';

/** `#topology=<id>` in the URL picks the initial topology (first step toward share links). */
export function topologyFromHash(hash: string): string | null {
  const v = new URLSearchParams(hash.replace(/^#/, '')).get('topology');
  return v && v.length > 0 ? v : null;
}

function initialTopology(): string {
  if (typeof window === 'undefined') return DEFAULT_TOPOLOGY;
  return topologyFromHash(window.location.hash) ?? DEFAULT_TOPOLOGY;
}

/**
 * State reset whenever the simulation is rebuilt. Hover and context menus refer to elements of
 * the old run.
 */
const freshRun = (s: UiState) => ({
  simEpoch: s.simEpoch + 1,
  queued: 0,
  actionsApplied: 0,
  hoveredLink: null,
  contextMenu: null,
});

export const useUi = create<UiState>()((set) => ({
  topologyId: initialTopology(),
  scenarioId: null,
  versions: { nutanix: '', flasharray: undefined },
  simEpoch: 0,
  selection: null,
  hoveredLink: null,
  contextMenu: null,
  tab: 'inspector',
  speed: 1,
  playing: false,
  manual: false,
  queued: 0,
  actionsApplied: 0,
  activityTicks: 10,
  bondUtilHost: null,
  layoutEdit: false,
  traffic: typeof window === 'undefined' ? presetFilter('storage') : loadTrafficFilter(),

  select: (selection) => set({ selection, contextMenu: null }),
  setHoveredLink: (hoveredLink) => set({ hoveredLink }),
  openContextMenu: (contextMenu) => set({ contextMenu }),
  setTab: (tab) => set({ tab }),
  setSpeed: (speed) => set({ speed }),
  setPlaying: (playing) => set((s) => ({ playing: playing && !s.manual })),
  setManual: (manual) => set((s) => ({ manual, playing: manual ? false : s.playing })),
  noteActionQueued: () =>
    set((s) => ({ queued: s.queued + 1, actionsApplied: s.actionsApplied + 1 })),
  noteTicked: () => set((s) => (s.queued === 0 ? s : { queued: 0 })),
  setTopology: (topologyId) =>
    set((s) => ({
      ...freshRun(s),
      topologyId,
      scenarioId: null,
      selection: null,
      bondUtilHost: null,
      playing: false,
    })),
  loadScenario: (scenarioId, topology) =>
    set((s) => ({
      ...freshRun(s),
      scenarioId,
      topologyId: topology ?? s.topologyId,
      selection: null,
      bondUtilHost: null,
      playing: false,
    })),
  setVersions: (versions) => set((s) => ({ ...freshRun(s), versions })),
  resetSim: () => set((s) => ({ ...freshRun(s), playing: false })),
  setActivityTicks: (activityTicks) => set({ activityTicks }),
  setBondUtilHost: (bondUtilHost) => set({ bondUtilHost }),
  setLayoutEdit: (layoutEdit) => set({ layoutEdit }),
  toggleTraffic: (category) =>
    set((s) => ({ traffic: saveTrafficFilter(toggleCategory(s.traffic, category)) })),
  setTrafficPreset: (preset) => set({ traffic: saveTrafficFilter(presetFilter(preset)) }),
}));
