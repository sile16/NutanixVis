/**
 * Fixture diagram layout for T1 (stream B). Absolute flow coordinates for leaf devices; group
 * bounds (hosts, CVMs, FlashArray, controllers, ports with interfaces) are computed by the UI
 * from their children. Same shape as `Topology['layout']`, so stream D can paste the output of
 * the dev-only "Copy layout JSON" button straight into a topology file.
 */
import type { Topology } from '../../topologies/schema';

type Layout = Topology['layout'];

const HOST_PITCH = 380;

function host(n: number): Layout {
  const ox = (n - 1) * HOST_PITCH;
  const h = `node-${n}`;
  return {
    [`${h}.vm-1`]: { x: ox + 10, y: 40, w: 88, h: 36 },
    [`${h}.vm-2`]: { x: ox + 102, y: 40, w: 88, h: 36 },
    [`${h}.cvm.storage-a`]: { x: ox + 200, y: 68, w: 53, h: 22 },
    [`${h}.cvm.storage-b`]: { x: ox + 259, y: 68, w: 53, h: 22 },
    [`${h}.vs0`]: { x: ox + 12, y: 110, w: 140, h: 26 },
    [`${h}.vs1`]: { x: ox + 164, y: 110, w: 148, h: 26 },
    [`${h}.eth0`]: { x: ox + 20, y: 150, w: 56, h: 28 },
    [`${h}.eth2`]: { x: ox + 92, y: 150, w: 56, h: 28 },
    [`${h}.eth1`]: { x: ox + 176, y: 150, w: 56, h: 28 },
    [`${h}.eth3`]: { x: ox + 248, y: 150, w: 56, h: 28 },
  };
}

export const t1Layout: Layout = {
  ...host(1),
  ...host(2),
  ...host(3),
  ...host(4),
  'sw-a': { x: 60, y: 330, w: 620, h: 60 },
  'sw-b': { x: 800, y: 330, w: 620, h: 60 },
  'fa.ct0.eth10.v10': { x: 480, y: 572, w: 96, h: 22 },
  'fa.ct0.eth11.v20': { x: 600, y: 572, w: 96, h: 22 },
  'fa.ct1.eth10.v10': { x: 780, y: 572, w: 96, h: 22 },
  'fa.ct1.eth11.v20': { x: 900, y: 572, w: 96, h: 22 },
};
