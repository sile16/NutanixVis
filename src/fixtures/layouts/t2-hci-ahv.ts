/** Fixture diagram layout for T2 (stream B). See `t1-ahv-flasharray.ts` for conventions. */
import type { Topology } from '../../topologies/schema';

type Layout = Topology['layout'];

const HOST_PITCH = 270;

function host(n: number): Layout {
  const ox = (n - 1) * HOST_PITCH;
  const h = `node-${n}`;
  return {
    [`${h}.vm-1`]: { x: ox + 12, y: 40, w: 92, h: 36 },
    [`${h}.cvm`]: { x: ox + 112, y: 40, w: 104, h: 36 },
    [`${h}.disk-1`]: { x: ox + 112, y: 82, w: 50, h: 20 },
    [`${h}.disk-2`]: { x: ox + 166, y: 82, w: 50, h: 20 },
    [`${h}.vs0`]: { x: ox + 12, y: 112, w: 204, h: 26 },
    [`${h}.eth0`]: { x: ox + 34, y: 150, w: 56, h: 28 },
    [`${h}.eth1`]: { x: ox + 140, y: 150, w: 56, h: 28 },
  };
}

export const t2Layout: Layout = {
  ...host(1),
  ...host(2),
  ...host(3),
  ...host(4),
  'sw-a': { x: 20, y: 330, w: 460, h: 60 },
  'sw-b': { x: 560, y: 330, w: 460, h: 60 },
};
