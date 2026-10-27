/**
 * Device/link id builders and per-topology id sets, matching stream D's topologies
 * (`src/topologies/*`) and the shared conventions. `tests/scenarios.test.ts` checks every
 * timeline target and option against the built topologies.
 */

export const nodeId = (n: number): string => `node-${n}`;
export const nicId = (n: number, k: number): string => `node-${n}.eth${k}`;
export const cvmId = (n: number): string => `node-${n}.cvm`;
export const vsId = (n: number, k: number): string => `node-${n}.vs${k}`;
export const vmId = (n: number, m: number): string => `node-${n}.vm-${m}`;
export const diskId = (n: number, d: number): string => `node-${n}.disk-${d}`;
export const segId = (n: number, segment: string): string => `node-${n}.cvm.${segment}`;
export const linkId = (a: string, b: string): string => `l-${a}--${b}`;

export const SW_A = 'sw-a';
export const SW_B = 'sw-b';
export const ISL = linkId(SW_A, SW_B);
export const FA = 'fa';
export const CT0 = 'fa.ct0';
export const CT1 = 'fa.ct1';
/** FlashArray management VIP (fa-interface, service `mgmt`). */
export const FA_MGMT = 'fa.vir0';

/** Path id used by `cvm.nvmePaths`: `<cvm-interface id>~<fa-interface id>`. */
export const pathId = (local: string, remote: string): string => `${local}~${remote}`;

export const range = (from: number, to: number): readonly number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** T1 default: 4 nodes; vs0 = eth0 (A) + eth2 (B), vs1 = eth1 (A) + eth3 (B). */
export const T1 = {
  topology: 't1-ahv-flasharray',
  nodes: range(1, 4),
  storageVs: (n: number): string => vsId(n, 1),
  storageNicA: (n: number): string => nicId(n, 1),
  storageNicB: (n: number): string => nicId(n, 3),
  segA: (n: number): string => segId(n, 'storage-a'),
  segB: (n: number): string => segId(n, 'storage-b'),
  faIfacesA: ['fa.ct0.eth10.v10', 'fa.ct1.eth10.v10'],
  faIfacesB: ['fa.ct0.eth11.v20', 'fa.ct1.eth11.v20'],
} as const;

/**
 * T1-lab default: 3 nodes, one NIC each (eth0, no-bond on vs0); odd nodes cable to Switch A,
 * even nodes to Switch B. Every FA data port (eth10 → A, eth11 → B) has a .v10 and a .v20 IP.
 */
export const T1_LAB = {
  topology: 't1-lab',
  nodes: range(1, 3),
  nic: (n: number): string => nicId(n, 0),
  nicLink: (n: number): string => linkId(nicId(n, 0), n % 2 === 1 ? SW_A : SW_B),
  faIfacesVlan10: ['fa.ct0.eth10.v10', 'fa.ct0.eth11.v10', 'fa.ct1.eth10.v10', 'fa.ct1.eth11.v10'],
} as const;

/** T2/T3 hosts: vs0 = eth0 (Switch A) + eth1 (Switch B). */
const hciUplinks = {
  vs: (n: number): string => vsId(n, 0),
  nicA: (n: number): string => nicId(n, 0),
  nicB: (n: number): string => nicId(n, 1),
  linkA: (n: number): string => linkId(nicId(n, 0), SW_A),
  linkB: (n: number): string => linkId(nicId(n, 1), SW_B),
};

export const T2 = { topology: 't2-hci-ahv', nodes: range(1, 4), ...hciUplinks } as const;

/** CO nodes are numbered first, then the CVM-bearing nodes. */
export const T3_CO_SO = {
  topology: 't3-co-so',
  co: range(1, 3),
  so: range(4, 7),
  ...hciUplinks,
} as const;

export const T3_CO_HCI = {
  topology: 't3-co-hci',
  co: range(1, 2),
  hci: range(3, 6),
  ...hciUplinks,
} as const;
