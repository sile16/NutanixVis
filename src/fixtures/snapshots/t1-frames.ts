/**
 * Hand-authored T1 fixture frames (SPEC §13.3) for the UI stream: 4 AHV nodes + 2 switches +
 * an Everpure FlashArray, following the SPEC §6.5 default (vs1 MAC pinning, both storage VLANs
 * trunked on both switches). NOT simulation output: the engine replaces this.
 *
 * Frames:
 *  - `steady`: all healthy, 4 NVMe/TCP paths per CVM.
 *  - `swAFailing`: the tick Switch A dies; in-flight frames on its cables are dropped.
 *  - `fabricB`: bonds have failed over; paths to the FA ports on Switch A are lost, IO continues
 *    on the Switch B paths (SPEC §6.4a "One storage switch down").
 *
 * Event `causeIds` use the `e<seq>` convention local to each frame; the mock renumbers them.
 */
import type {
  DeviceStatus,
  DeviceView,
  LinkView,
  SimEvent,
  Snapshot,
  Trace,
  ViewField,
} from '../../engine/types';

export const T1_NODES = [1, 2, 3, 4] as const;

type Phase = 'steady' | 'swAFailing' | 'fabricB';

function dev(
  id: string,
  kind: string,
  label: string,
  parent: string | undefined,
  status: DeviceStatus,
  fields: Record<string, ViewField> = {},
  badges: string[] = [],
): DeviceView {
  return parent === undefined
    ? { id, kind, label, status, badges, fields }
    : { id, kind, label, parent, status, badges, fields };
}

function link(
  id: string,
  a: [string, string],
  b: [string, string],
  up: boolean,
  util: Record<string, number>,
  mtu = 9000,
): LinkView {
  return {
    id,
    a: { device: a[0], port: a[1] },
    b: { device: b[0], port: b[1] },
    status: up ? 'up' : 'down',
    mtu,
    latencyMs: 0,
    util: up ? util : {},
  };
}

function devices(phase: Phase): Record<string, DeviceView> {
  const down = phase !== 'steady';
  const out: Record<string, DeviceView> = {};
  const add = (d: DeviceView) => {
    out[d.id] = d;
  };

  add(
    dev('sw-a', 'switch', 'Switch A', undefined, down ? 'failed' : 'healthy', {
      vlans: '10,20,100,200',
      mtu: 9216,
      portsUp: down ? 0 : 11,
    }),
  );
  add(
    dev('sw-b', 'switch', 'Switch B', undefined, 'healthy', {
      vlans: '10,20,100,200',
      mtu: 9216,
      portsUp: down ? 10 : 11,
    }),
  );

  for (const n of T1_NODES) {
    const host = `node-${n}`;
    const degraded: DeviceStatus = down ? 'degraded' : 'healthy';
    add(
      dev(
        host,
        'ahv-host',
        `Node ${n}`,
        undefined,
        degraded,
        { role: 'external-storage-compute', ahv: '11.0', vms: 2 },
        n === 1 ? ['acropolis-leader'] : [],
      ),
    );
    const cvmBadges = n === 1 ? ['zk-leader'] : n <= 3 ? ['zk'] : [];
    add(
      dev(
        `${host}.cvm`,
        'cvm',
        `CVM ${n}`,
        host,
        degraded,
        {
          stargate: 'up',
          nvmePathsUp: down ? 2 : 4,
          nvmePathsTotal: 4,
          vdisksOwned: 6,
        },
        cvmBadges,
      ),
    );
    add(
      dev(`${host}.cvm.storage-a`, 'cvm-interface', 'v10', `${host}.cvm`, 'healthy', {
        vlan: 10,
        ip: `10.10.0.${10 + n}`,
        vswitch: 'vs1',
        pinnedUplink: phase === 'fabricB' ? `${host}.eth3` : `${host}.eth1`,
        nvmePaths: down ? '0/2' : '2/2',
      }),
    );
    add(
      dev(`${host}.cvm.storage-b`, 'cvm-interface', 'v20', `${host}.cvm`, 'healthy', {
        vlan: 20,
        ip: `10.20.0.${10 + n}`,
        vswitch: 'vs1',
        pinnedUplink: `${host}.eth3`,
        nvmePaths: '2/2',
      }),
    );
    for (const m of [1, 2]) {
      add(
        dev(`${host}.vm-${m}`, 'vm', `app-${n}${m}`, host, 'healthy', {
          power: 'on',
          ioState: 'running',
          vdisks: 3,
          readLatencyMs: down ? 0.7 : 0.5,
          writeLatencyMs: down ? 0.5 : 0.3,
        }),
      );
    }
    add(
      dev(`${host}.vs0`, 'vswitch', 'vs0', host, degraded, {
        bondMode: 'active-backup',
        uplinks: `${host}.eth0,${host}.eth2`,
        activeMember: down ? `${host}.eth2` : `${host}.eth0`,
        mtu: 1500,
      }),
    );
    add(
      dev(`${host}.vs1`, 'vswitch', 'vs1', host, degraded, {
        bondMode: 'balance-slb',
        uplinks: `${host}.eth1,${host}.eth3`,
        membersUp: down ? 1 : 2,
        mtu: 9000,
      }),
    );
    for (const k of [0, 1, 2, 3]) {
      const onA = k === 0 || k === 1;
      add(
        dev(`${host}.eth${k}`, 'nic', `eth${k}`, host, down && onA ? 'offline' : 'healthy', {
          speedGbps: 25,
          mtu: k % 2 === 0 ? 1500 : 9000,
          switch: onA ? 'sw-a' : 'sw-b',
          carrier: !(down && onA),
        }),
      );
    }
  }

  add(
    dev('fa', 'fa-array', 'FlashArray//X', undefined, down ? 'degraded' : 'healthy', {
      vendor: 'Everpure',
      purity: '6.12',
      volumes: 32,
    }),
  );
  for (const ct of [0, 1]) {
    const c = `fa.ct${ct}`;
    add(
      dev(
        c,
        'fa-controller',
        `CT${ct}`,
        'fa',
        down ? 'degraded' : 'healthy',
        { role: ct === 0 ? 'primary' : 'secondary' },
        ct === 0 ? ['fa-primary'] : [],
      ),
    );
    for (const [port, vlan] of [
      ['eth10', 10],
      ['eth11', 20],
    ] as const) {
      const portDown = down && port === 'eth10';
      const st: DeviceStatus = portDown ? 'offline' : 'healthy';
      add(
        dev(`${c}.${port}`, 'nic', port, c, st, {
          speedGbps: 25,
          switch: port === 'eth10' ? 'sw-a' : 'sw-b',
        }),
      );
      add(
        dev(`${c}.${port}.v${vlan}`, 'fa-interface', `v${vlan}`, `${c}.${port}`, st, {
          vlan,
          ip: `10.${vlan}.0.${100 + ct}`,
          service: 'nvme-tcp',
        }),
      );
    }
  }
  return out;
}

function links(phase: Phase): Record<string, LinkView> {
  const aUp = phase === 'steady';
  const out: Record<string, LinkView> = {};
  const add = (l: LinkView) => {
    out[l.id] = l;
  };
  for (const n of T1_NODES) {
    const io = phase === 'fabricB' ? 24 : 12;
    add(
      link(`l-n${n}-eth0`, [`node-${n}.eth0`, 'p0'], ['sw-a', `p${2 * n - 1}`], aUp, { mgmt: 3 }),
    );
    add(
      link(`l-n${n}-eth1`, [`node-${n}.eth1`, 'p0'], ['sw-a', `p${2 * n}`], aUp, {
        'io-read': 6,
        'io-write': 6,
      }),
    );
    add(
      link(`l-n${n}-eth2`, [`node-${n}.eth2`, 'p0'], ['sw-b', `p${2 * n - 1}`], true, {
        mgmt: aUp ? 0 : 3,
      }),
    );
    add(
      link(`l-n${n}-eth3`, [`node-${n}.eth3`, 'p0'], ['sw-b', `p${2 * n}`], true, {
        'io-read': io / 2,
        'io-write': io / 2,
      }),
    );
  }
  for (const ct of [0, 1]) {
    add(
      link(`l-ct${ct}-eth10`, [`fa.ct${ct}.eth10`, 'p0'], ['sw-a', `p${17 + ct}`], aUp, {
        'io-read': 12,
        'io-write': 12,
      }),
    );
    add(
      link(`l-ct${ct}-eth11`, [`fa.ct${ct}.eth11`, 'p0'], ['sw-b', `p${17 + ct}`], true, {
        'io-read': aUp ? 12 : 24,
        'io-write': aUp ? 12 : 24,
      }),
    );
  }
  add(link('l-isl', ['sw-a', 'p48'], ['sw-b', 'p48'], aUp, { mgmt: 1 }, 9216));
  return out;
}

function traces(phase: Phase): Trace[] {
  const out: Trace[] = [];
  let i = 0;
  const id = () => `t1-${phase}-${++i}`;
  const delivered = (kind: string, category: string, round: number, ls: string[]): Trace => ({
    msgId: id(),
    kind,
    category,
    round,
    links: ls,
    result: 'delivered',
  });

  for (const n of T1_NODES) {
    const nic = (k: number) => `l-n${n}-eth${k}`;
    // NVMe/TCP IO on the four CVM paths (2 vNICs × 2 FA ports per VLAN, SPEC §6.4b).
    const paths: Array<{ uplink: number; fa: string; onA: boolean }> = [
      { uplink: 1, fa: 'l-ct0-eth10', onA: true },
      { uplink: 1, fa: 'l-ct1-eth10', onA: true },
      { uplink: 3, fa: 'l-ct0-eth11', onA: false },
      { uplink: 3, fa: 'l-ct1-eth11', onA: false },
    ];
    paths.forEach((p, j) => {
      const category = j % 2 === 0 ? 'io-read' : 'io-write';
      if (p.onA && phase === 'swAFailing') {
        out.push({
          msgId: id(),
          kind: 'nvme-io',
          category,
          round: 0,
          links: [nic(p.uplink)],
          result: 'dropped',
          dropAt: nic(p.uplink),
          reason: 'link-down',
        });
        return;
      }
      if (p.onA && phase === 'fabricB') return;
      const reps = phase === 'fabricB' ? 2 : 1;
      for (let r = 0; r < reps; r++) {
        out.push(delivered('nvme-io', category, 0, [nic(p.uplink), p.fa]));
        out.push(delivered('nvme-io', category, 1, [p.fa, nic(p.uplink)]));
      }
    });
    if (phase === 'fabricB') {
      // The storage-a vNIC moved to eth3, but its VLAN-10 targets are on the dead switch.
      out.push({
        msgId: id(),
        kind: 'nvme-connect',
        category: 'nvme-keepalive',
        round: 0,
        links: [nic(3)],
        result: 'dropped',
        dropAt: 'sw-b',
        reason: 'no-route',
      });
    }
    out.push(
      delivered('nvme-keepalive', 'nvme-keepalive', 2, [
        nic(3),
        n % 2 ? 'l-ct0-eth11' : 'l-ct1-eth11',
      ]),
    );

    // AHV HA heartbeats to the Acropolis leader on node 1 over vs0.
    if (n !== 1) {
      if (phase === 'steady') {
        out.push(delivered('ha-poll', 'ha-poll', 0, [nic(0), 'l-n1-eth0']));
        out.push(delivered('ha-poll', 'ha-poll', 1, ['l-n1-eth0', nic(0)]));
      } else if (phase === 'swAFailing') {
        out.push({
          msgId: id(),
          kind: 'ha-poll',
          category: 'ha-poll',
          round: 0,
          links: [nic(0)],
          result: 'dropped',
          dropAt: nic(0),
          reason: 'link-down',
        });
      } else {
        out.push(delivered('ha-poll', 'ha-poll', 0, [nic(2), 'l-n1-eth2']));
        out.push(delivered('ha-poll', 'ha-poll', 1, ['l-n1-eth2', nic(2)]));
      }
    }
  }
  return out;
}

function events(phase: Phase): SimEvent[] {
  if (phase === 'steady') return [];
  if (phase === 'swAFailing') {
    return [
      {
        seq: 1,
        t: 0,
        severity: 'error',
        deviceId: 'sw-a',
        code: 'switch.failed',
        text: 'Switch A failed: all of its ports lost carrier.',
        causeIds: [],
        cite: [],
        confidence: 'verified',
      },
      ...T1_NODES.map(
        (n, j): SimEvent => ({
          seq: 2 + j,
          t: 0,
          severity: 'warn',
          deviceId: `node-${n}.vs1`,
          code: 'bond.member.down',
          text: `Node ${n} vs1: member eth1 lost carrier (detected immediately in every bond mode).`,
          causeIds: ['e1'],
          cite: [],
          confidence: 'verified',
        }),
      ),
    ];
  }
  return [
    ...T1_NODES.map(
      (n, j): SimEvent => ({
        seq: 1 + j,
        t: 0,
        severity: 'info',
        deviceId: `node-${n}.vs1`,
        code: 'bond.failover',
        text: `Node ${n} vs1 (MAC pinning): storage-a vNIC (VLAN 10) moved from eth1 to eth3.`,
        causeIds: [],
        cite: [],
        confidence: 'inferred',
      }),
    ),
    {
      seq: 5,
      t: 0,
      severity: 'warn',
      deviceId: 'node-1.cvm',
      code: 'nvme.path.lost',
      text: 'CVM 1 lost 2 of 4 NVMe/TCP paths (ct0.eth10, ct1.eth10 are behind Switch A).',
      causeIds: ['e1'],
      cite: [],
      confidence: 'assumption',
    },
    {
      seq: 6,
      t: 0,
      severity: 'info',
      deviceId: 'node-1.cvm',
      code: 'nvme.io.redistributed',
      text: 'IO continues on the remaining ANA-optimized paths via Switch B.',
      causeIds: ['e5'],
      cite: ['ntnx-bible-ahv-how-it-works'],
      confidence: 'inferred',
    },
  ];
}

function frame(phase: Phase): Snapshot {
  return {
    version: 0,
    simTime: 0,
    seed: 1,
    topologyId: 't1-ahv-flasharray',
    versions: { nutanix: 'aos-7.6', flasharray: 'purity-6.12', profileId: 'current' },
    devices: devices(phase),
    links: links(phase),
    traces: traces(phase),
    events: events(phase),
    derived: {
      haStatus: phase === 'steady' ? 'OK' : 'OK',
      zkQuorum: true,
      nodeFailureTolerance: 2,
      nvmePathsUp: phase === 'steady' ? 16 : 8,
    },
    nextTimerAt: null,
  };
}

export const t1Frames = {
  steady: frame('steady'),
  swAFailing: frame('swAFailing'),
  fabricB: frame('fabricB'),
} as const satisfies Record<Phase, Snapshot>;
