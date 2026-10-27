/**
 * Fixture topology catalog for the UI shell (stream B). Integration (stream I) replaces this with
 * the real topologies from `src/topologies` and `createSimulation` from the engine; the shape
 * below is what the UI needs from that wiring.
 */
import type { Simulation, VersionSelection } from '../engine/types';
import type { Topology } from '../topologies/schema';
import { t1Layout } from './layouts/t1-ahv-flasharray';
import { t2Layout } from './layouts/t2-hci-ahv';
import { createMockSimulation } from './mock-simulation';
import { t1Frames } from './snapshots/t1-frames';
import { t2Steady } from './snapshots/t2-frames';

export interface CatalogEntry {
  readonly id: string;
  readonly title: string;
  /** Topologies with an external array show the FlashArray version select. */
  readonly hasFlashArray: boolean;
  readonly layout: Topology['layout'];
  createSimulation(versions: VersionSelection): Simulation;
}

export const fixtureCatalog: readonly CatalogEntry[] = [
  {
    id: 't1-ahv-flasharray',
    title: 'T1 · AHV + Everpure FlashArray',
    hasFlashArray: true,
    layout: t1Layout,
    createSimulation: (versions) =>
      createMockSimulation({
        versions,
        frames: [
          { snapshot: t1Frames.steady, holdTicks: 6 },
          { snapshot: t1Frames.swAFailing, holdTicks: 1 },
          { snapshot: t1Frames.fabricB, holdTicks: 8 },
        ],
      }),
  },
  {
    id: 't2-hci-ahv',
    title: 'T2 · Nutanix HCI on AHV',
    hasFlashArray: false,
    layout: t2Layout,
    createSimulation: (versions) =>
      createMockSimulation({ versions, frames: [{ snapshot: t2Steady, holdTicks: 1 }] }),
  },
];
