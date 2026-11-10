/**
 * The topology comparison chart (Compare dialog): the five storage-network configurations side
 * by side, on setup, pathing, ISL use, failures and configuration risk. Every claim is what the
 * simulator's models do, and every failure row links to the guided scenario that shows it on
 * that configuration (`src/scenarios/guided`), whose walkthrough is checked against its own run.
 * `comparison.test.ts` checks that every link exists.
 */
import type { T1ConfigKey } from '../../topologies/t1-configs';

/** good: no impact; warn: a short or partial impact; bad: a lasting or silent risk. */
export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export interface Cell {
  readonly text: string;
  readonly tone?: Tone;
  /** Guided scenario numbers (`GuidedFamily.n`) that show this on the column's configuration. */
  readonly try?: readonly number[];
}

export interface Row {
  readonly label: string;
  readonly cells: Readonly<Record<T1ConfigKey, Cell>>;
}

export interface Section {
  readonly title: string;
  readonly rows: readonly Row[];
}

const KEYS: readonly T1ConfigKey[] = [
  'two-vswitches',
  'slb-4ip',
  'slb-8ip',
  'lacp-4ip',
  'lacp-8ip',
];

/** Columns grouped: the same cell for every configuration in a group. */
function cells(
  by: Partial<Record<T1ConfigKey | 'bonded' | 'slb' | 'lacp' | 'all' | 'ip4' | 'ip8', Cell>>,
): Readonly<Record<T1ConfigKey, Cell>> {
  const pick = (k: T1ConfigKey): Cell => {
    const group = k.startsWith('slb') ? 'slb' : k.startsWith('lacp') ? 'lacp' : null;
    const ips = k.endsWith('8ip') ? 'ip8' : 'ip4';
    const cell =
      by[k] ??
      (group ? by[group] : undefined) ??
      (group ? by.bonded : undefined) ??
      by[ips] ??
      by.all;
    if (!cell) throw new Error(`comparison: no cell for ${k}`);
    return cell;
  };
  return Object.fromEntries(KEYS.map((k) => [k, pick(k)])) as Record<T1ConfigKey, Cell>;
}

export const COLUMNS: readonly {
  readonly key: T1ConfigKey;
  readonly head: string;
  readonly sub: string;
}[] = [
  { key: 'two-vswitches', head: 'Two vSwitches', sub: 'no bond · 4 array IPs' },
  { key: 'slb-4ip', head: 'MAC pinning', sub: 'one vSwitch · 4 array IPs' },
  { key: 'slb-8ip', head: 'MAC pinning', sub: 'one vSwitch · 8 array IPs' },
  { key: 'lacp-4ip', head: 'LACP + MLAG', sub: 'one vSwitch · 4 array IPs' },
  { key: 'lacp-8ip', head: 'LACP + MLAG', sub: 'one vSwitch · 8 array IPs' },
];

export const COMPARISON: readonly Section[] = [
  {
    title: 'Setup',
    rows: [
      {
        label: 'Host',
        cells: cells({
          'two-vswitches': {
            text: 'vs1 on eth2 and vs2 on eth3, no bond; one storage interface each',
          },
          slb: {
            text: 'vs1 bonds eth2 + eth3 (balance-slb); two storage interfaces, one per VLAN',
          },
          lacp: {
            text: 'vs1 bonds eth2 + eth3 with LACP (balance-tcp, fast rate); two storage interfaces',
          },
        }),
      },
      {
        label: 'Switches',
        cells: cells({
          'two-vswitches': {
            text: 'Storage VLAN A on Switch A, VLAN B on Switch B; storage never needs the ISL',
            tone: 'good',
          },
          slb: { text: 'Both storage VLANs on every node port and the ISL; no port-channel' },
          lacp: {
            text: 'Both storage VLANs everywhere, plus an MLAG (vPC) port-channel per node',
            tone: 'warn',
          },
        }),
      },
      {
        label: 'Array data IPs',
        cells: cells({
          ip4: { text: '4: one per port, each port in one VLAN (access)' },
          ip8: { text: '8: both VLANs on every port (trunked)' },
        }),
      },
      {
        label: 'NVMe paths per CVM',
        cells: cells({
          ip4: { text: '4 (two per storage interface, one to each controller)' },
          ip8: { text: '8 (four per storage interface, two on each switch)' },
        }),
      },
      {
        label: 'Setup effort',
        cells: cells({
          'two-vswitches': {
            text: 'Two vSwitches per host; NVMe multipathing is the only redundancy (allowed as an exception to the bonded default)',
          },
          slb: {
            text: 'Fewest steps: one vSwitch, nothing to configure on the switches beyond VLANs',
            tone: 'good',
          },
          lacp: {
            text: 'Most: the switch port-channels and MLAG must match every host',
            tone: 'warn',
          },
        }),
      },
    ],
  },
  {
    title: 'Pathing and ISL use',
    rows: [
      {
        label: 'Which NIC a path uses',
        cells: cells({
          'two-vswitches': {
            text: 'Fixed by the cabling: storage-a on eth2, storage-b on eth3',
            tone: 'good',
          },
          slb: {
            text: 'Each storage interface is pinned to one NIC: decided by which NIC links up first at boot, and by the rebalance after a link returns',
          },
          lacp: {
            text: 'Each NVMe connection is hashed onto a NIC; the array side’s switch sends every reply out its own member',
          },
        }),
      },
      {
        label: 'ISL share of storage IO, steady state',
        cells: cells({
          'two-vswitches': { text: 'None', tone: 'good' },
          'slb-4ip': {
            text: '0 % on a node that booted home; 100 %, both ways, on one that booted swapped (node 2 here)',
            tone: 'bad',
            try: [4],
          },
          'slb-8ip': { text: 'About half on every node, swapped or not', tone: 'warn', try: [4] },
          'lacp-4ip': {
            text: 'Host → array: anywhere from 0 to 100 % per node, by connection hash. Replies: none',
            tone: 'warn',
            try: [4],
          },
          'lacp-8ip': {
            text: 'Host → array: about half or more per node. Replies: none',
            tone: 'warn',
            try: [4],
          },
        }),
      },
      {
        label: 'Placement drift',
        cells: cells({
          'two-vswitches': { text: 'None: the layout is the cabling', tone: 'good' },
          'slb-4ip': {
            text: 'A link return or a host reboot can leave a node swapped, silently and for good; a switch return heals it',
            tone: 'bad',
            try: [3, 6],
          },
          'slb-8ip': {
            text: 'Swaps happen, but cost nothing: every VLAN has ports on both switches',
            tone: 'good',
            try: [3, 6],
          },
          lacp: { text: 'Nothing sticks: connections rehash on every change', tone: 'good' },
        }),
      },
    ],
  },
  {
    title: 'Failures (open a cell’s scenario to watch it)',
    rows: [
      {
        label: 'One array port',
        cells: cells({
          ip4: {
            text: 'Brief partial stall: one of four paths lost, keep-alive moves the IO',
            tone: 'warn',
            try: [1],
          },
          ip8: {
            text: 'Brief partial stall: two of eight paths lost, keep-alive moves the IO',
            tone: 'warn',
            try: [1],
          },
        }),
      },
      {
        label: 'Controller crash',
        cells: cells({
          all: {
            text: 'Every IO pauses until the partner takes over, then completes; a planned reboot drains first and pauses nothing',
            tone: 'warn',
            try: [2],
          },
        }),
      },
      {
        label: 'Storage NIC or cable fails',
        cells: cells({
          'two-vswitches': {
            text: 'Brief partial stall: that NIC’s paths are lost',
            tone: 'warn',
            try: [3],
          },
          bonded: {
            text: 'No interruption: the bond moves the vNIC, no path is lost',
            tone: 'good',
            try: [3],
          },
        }),
      },
      {
        label: '… and it comes back',
        cells: cells({
          'two-vswitches': {
            text: 'Its paths reconnect; the layout is as before',
            tone: 'good',
            try: [3],
          },
          'slb-4ip': {
            text: 'The node ends up swapped: all its storage IO crosses the ISL, and nothing alerts',
            tone: 'bad',
            try: [3],
          },
          'slb-8ip': { text: 'The node ends up swapped, at no cost', tone: 'good', try: [3] },
          lacp: { text: 'Connections spread over both NICs again', tone: 'good', try: [3] },
        }),
      },
      {
        label: 'Storage NIC hangs, link up',
        cells: cells({
          'two-vswitches': {
            text: 'The vSwitch sees nothing; keep-alive drops that NIC’s paths after a brief partial stall',
            tone: 'warn',
            try: [10],
          },
          'slb-4ip': {
            text: 'The bond sees nothing; keep-alive drops the hung NIC’s paths after a brief partial stall',
            tone: 'warn',
            try: [10],
          },
          'slb-8ip': {
            text: 'The bond sees nothing; all IO stalls for a step (the dead paths soak up the queue) until keep-alive drops them',
            tone: 'bad',
            try: [10],
          },
          lacp: {
            text: 'All IO stalls briefly, then LACP misses the LACPDUs and moves everything in the same step; no path is lost',
            tone: 'good',
            try: [10],
          },
        }),
      },
      {
        label: 'Storage switch fails',
        cells: cells({
          all: {
            text: 'Brief partial stall; IO carries on through the other switch at half the bandwidth',
            tone: 'warn',
            try: [9],
          },
          'slb-4ip': {
            text: 'Brief partial stall; IO carries on through the other switch. Its return moves swapped nodes home',
            tone: 'warn',
            try: [9],
          },
        }),
      },
      {
        label: 'Packet loss on the ISL',
        cells: cells({
          'two-vswitches': { text: 'No effect: no storage IO crosses it', tone: 'good', try: [5] },
          'slb-4ip': {
            text: 'Only swapped nodes slow down (retransmissions); nothing stalls or alerts',
            tone: 'warn',
            try: [5],
          },
          'slb-8ip': {
            text: 'Every node slows down; nothing stalls or alerts',
            tone: 'bad',
            try: [5],
          },
          lacp: {
            text: 'Writes on connections hashed across it slow down; reads come back locally and are spared',
            tone: 'warn',
            try: [5],
          },
        }),
      },
      {
        label: 'Host reboot',
        cells: cells({
          'two-vswitches': { text: 'No effect on pathing', tone: 'good' },
          'slb-4ip': {
            text: 'Can come back swapped (whichever NIC links up first): all its IO on the ISL',
            tone: 'bad',
            try: [6],
          },
          'slb-8ip': { text: 'Can come back swapped, at no cost', tone: 'good', try: [6] },
          lacp: { text: 'No effect on pathing', tone: 'good' },
        }),
      },
      {
        label: 'Stargate or CVM fails',
        cells: cells({
          all: {
            text: 'The same everywhere: Frodo, the AHV redirector, sends the VM’s IO to another CVM’s Stargate after a short stall; the VM keeps running',
            tone: 'warn',
            try: [7, 8],
          },
        }),
      },
    ],
  },
  {
    title: 'Configuration risk',
    rows: [
      {
        label: 'What to watch for',
        cells: cells({
          'two-vswitches': {
            text: 'Every NIC loss costs a short stall; each storage VLAN must stay on its own switch',
            tone: 'warn',
          },
          'slb-4ip': {
            text: 'Silent swaps put a node’s storage on the ISL: size the ISL for it and check placement after link events and reboots (ovs-appctl bond/show)',
            tone: 'bad',
          },
          'slb-8ip': {
            text: 'About half of all storage IO always crosses the ISL: size it for that',
            tone: 'warn',
          },
          lacp: {
            text: 'Needs MLAG: without it only one switch’s NICs aggregate. A member that hangs but keeps sending LACPDUs is never detected',
            tone: 'warn',
          },
        }),
      },
      {
        label: 'What tells you something is wrong',
        cells: cells({
          'two-vswitches': { text: 'Lost NVMe paths (keep-alive)' },
          slb: {
            text: 'Lost NVMe paths; a swap raises nothing: the bond, links and switches stay healthy',
            tone: 'warn',
          },
          lacp: { text: 'LACP member state, and lost NVMe paths' },
        }),
      },
    ],
  },
];
