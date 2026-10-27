/**
 * Hand-authored T2 (Nutanix HCI on AHV) fixture frame for the UI stream: 4 nodes, 2 ToRs with an
 * ISL, active-backup on vs0 (SPEC §6.5). No FlashArray, so the UI hides the FlashArray version
 * select. NOT simulation output.
 */
import type { DeviceView, LinkView, Snapshot, Trace } from '../../engine/types';

export const T2_NODES = [1, 2, 3, 4] as const;

function buildDevices(): Record<string, DeviceView> {
  const out: Record<string, DeviceView> = {
    'sw-a': {
      id: 'sw-a',
      kind: 'switch',
      label: 'Switch A',
      status: 'healthy',
      badges: [],
      fields: { vlans: '100,200', mtu: 9216 },
    },
    'sw-b': {
      id: 'sw-b',
      kind: 'switch',
      label: 'Switch B',
      status: 'healthy',
      badges: [],
      fields: { vlans: '100,200', mtu: 9216 },
    },
  };
  for (const n of T2_NODES) {
    const h = `node-${n}`;
    const list: DeviceView[] = [
      {
        id: h,
        kind: 'ahv-host',
        label: `Node ${n}`,
        status: 'healthy',
        badges: n === 2 ? ['acropolis-leader'] : [],
        fields: { role: 'hci', rf: 2 },
      },
      {
        id: `${h}.cvm`,
        kind: 'cvm',
        label: `CVM ${n}`,
        parent: h,
        status: 'healthy',
        badges: n === 1 ? ['zk-leader'] : n <= 3 ? ['zk'] : [],
        fields: { stargate: 'up', cassandra: 'normal' },
      },
      {
        id: `${h}.vm-1`,
        kind: 'vm',
        label: `web-${n}`,
        parent: h,
        status: 'healthy',
        badges: [],
        fields: { power: 'on', ioState: 'running' },
      },
      {
        id: `${h}.vs0`,
        kind: 'vswitch',
        label: 'vs0',
        parent: h,
        status: 'healthy',
        badges: [],
        fields: {
          bondMode: 'active-backup',
          uplinks: `${h}.eth0,${h}.eth1`,
          activeMember: `${h}.eth0`,
        },
      },
      ...[1, 2].map(
        (d): DeviceView => ({
          id: `${h}.disk-${d}`,
          kind: 'disk',
          label: `nvme${d}`,
          parent: h,
          status: 'healthy',
          badges: [],
          fields: { media: 'nvme', capacityTiB: 3.84 },
        }),
      ),
      ...[0, 1].map(
        (k): DeviceView => ({
          id: `${h}.eth${k}`,
          kind: 'nic',
          label: `eth${k}`,
          parent: h,
          status: 'healthy',
          badges: [],
          fields: { speedGbps: 25 },
        }),
      ),
    ];
    for (const d of list) out[d.id] = d;
  }
  return out;
}

function buildLinks(): Record<string, LinkView> {
  const out: Record<string, LinkView> = {};
  for (const n of T2_NODES) {
    for (const k of [0, 1]) {
      const id = `l-n${n}-eth${k}`;
      out[id] = {
        id,
        a: { device: `node-${n}.eth${k}`, port: 'p0' },
        b: { device: k === 0 ? 'sw-a' : 'sw-b', port: `p${n}` },
        status: 'up',
        mtu: 9000,
        latencyMs: 0,
        util: k === 0 ? { replication: 8, zk: 1 } : {},
      };
    }
  }
  out['l-isl'] = {
    id: 'l-isl',
    a: { device: 'sw-a', port: 'p48' },
    b: { device: 'sw-b', port: 'p48' },
    status: 'up',
    mtu: 9216,
    latencyMs: 0,
    util: {},
  };
  return out;
}

function buildTraces(): Trace[] {
  const out: Trace[] = [];
  let i = 0;
  for (const n of T2_NODES) {
    const peer = (n % 4) + 1;
    out.push({
      msgId: `t2-${++i}`,
      kind: 'oplog-replicate',
      category: 'replication',
      round: 0,
      links: [`l-n${n}-eth0`, `l-n${peer}-eth0`],
      result: 'delivered',
    });
    out.push({
      msgId: `t2-${++i}`,
      kind: 'oplog-ack',
      category: 'replication',
      round: 1,
      links: [`l-n${peer}-eth0`, `l-n${n}-eth0`],
      result: 'delivered',
    });
    if (n !== 1) {
      out.push({
        msgId: `t2-${++i}`,
        kind: 'zk-ping',
        category: 'zk',
        round: 0,
        links: [`l-n${n}-eth0`, 'l-n1-eth0'],
        result: 'delivered',
      });
    }
  }
  return out;
}

export const t2Steady: Snapshot = {
  version: 0,
  simTime: 0,
  seed: 1,
  topologyId: 't2-hci-ahv',
  versions: { nutanix: 'aos-7.6', profileId: 'current' },
  devices: buildDevices(),
  links: buildLinks(),
  traces: buildTraces(),
  events: [],
  derived: { haStatus: 'OK', zkQuorum: true, faultTolerance: 1 },
  nextTimerAt: null,
};
