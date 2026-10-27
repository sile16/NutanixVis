/**
 * UI-only state (SPEC §3): selection, playback speed, open tab, manual mode, view toggles.
 * Simulation state never lives here; it comes from `Simulation` snapshots (see `use-sim.ts`).
 */
import { create } from 'zustand';

export type Selection =
  | { readonly type: 'device'; readonly id: string }
  | { readonly type: 'link'; readonly id: string };

export const SPEEDS = [1, 5, 20, 60] as const;
export type Speed = (typeof SPEEDS)[number];

export type RailTab = 'inspector' | 'events' | 'explain' | 'scenario';
export type ThemePref = 'system' | 'light' | 'dark';

export interface VersionChoice {
  readonly nutanix: string;
  readonly flasharray: string | undefined;
}

export interface UiState {
  topologyId: string;
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
  showPackets: boolean;
  /** Host whose bond member utilization is shown on the diagram. */
  bondUtilHost: string | null;
  layoutEdit: boolean;
  explainEvent: number | null;
  theme: ThemePref;

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
  setVersions(v: VersionChoice): void;
  resetSim(): void;
  togglePackets(): void;
  setBondUtilHost(id: string | null): void;
  setLayoutEdit(on: boolean): void;
  explain(seq: number | null): void;
  setTheme(t: ThemePref): void;
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

export const useUi = create<UiState>()((set) => ({
  topologyId: initialTopology(),
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
  showPackets: true,
  bondUtilHost: null,
  layoutEdit: false,
  explainEvent: null,
  theme: 'system',

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
      topologyId,
      simEpoch: s.simEpoch + 1,
      selection: null,
      bondUtilHost: null,
      queued: 0,
      actionsApplied: 0,
      playing: false,
    })),
  setVersions: (versions) =>
    set((s) => ({ versions, simEpoch: s.simEpoch + 1, queued: 0, actionsApplied: 0 })),
  resetSim: () =>
    set((s) => ({ simEpoch: s.simEpoch + 1, queued: 0, actionsApplied: 0, playing: false })),
  togglePackets: () => set((s) => ({ showPackets: !s.showPackets })),
  setBondUtilHost: (bondUtilHost) => set({ bondUtilHost }),
  setLayoutEdit: (layoutEdit) => set({ layoutEdit }),
  explain: (explainEvent) =>
    set(explainEvent === null ? { explainEvent } : { explainEvent, tab: 'explain' }),
  setTheme: (theme) => set({ theme }),
}));
