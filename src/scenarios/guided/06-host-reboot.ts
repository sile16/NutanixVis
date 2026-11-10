/**
 * Guided 6: a planned host reboot (maintenance mode, reboot, exit) flips MAC pinning. OVS starts
 * afresh at boot and learns the storage interfaces in the order they first transmit, from the NIC
 * that links up first: a race, so a healthy node can come back swapped (docs/research/
 * ovs-bond-behavior.md S8). Node 1 booted home; this reboot brings it back swapped.
 */
import type { T1Config } from '../../topologies/t1-configs';
import { defineScenario, type ScenarioGuide } from '../define';
import { atCtx, baseInvariants, snapshotAt, T0, vswitch } from '../helpers';
import { T1 } from '../ids';
import { guideChecks } from '../steps';
import { type GuidedFamily, guidedId, guidedSteady, layoutWords, SLB_CONFIGS, VM1 } from './kit';

const REBOOT_AT = T0 + 40;
/** After the host and its CVM are back. */
const EXIT_AT = REBOOT_AT + 600;
const END = EXIT_AT + 60;

function build(c: T1Config) {
  const four = c.arrayIps === 4;
  const guide: ScenarioGuide = {
    vm: VM1,
    groups: [
      [
        {
          io: 'none',
          text: 'Node 1 enters maintenance mode: VM 1-1 live-migrates to another node first. No IO stalls.',
        },
      ],
      [
        {
          io: 'none',
          text: 'Node 1 reboots. Its CVM goes down with it; nothing runs on it now, so no VM notices. Press Next event until CVM 1 is back up, then apply the next change.',
        },
      ],
      [
        {
          io: 'none',
          text: four
            ? 'Node 1 leaves maintenance mode and VM 1-1 comes back. But OVS learned the storage interfaces afresh at boot, and eth3 linked up first: CVM 1 came back swapped, like node 2, so all its storage IO now crosses the ISL. The bond, both links and both switches are healthy, and nothing alerts.'
            : 'Node 1 leaves maintenance mode and VM 1-1 comes back. OVS learned the storage interfaces afresh at boot and CVM 1 came back swapped, like node 2; with 8 array IPs every VLAN has ports on both switches, so it costs nothing.',
        },
      ],
    ],
  };
  return defineScenario({
    id: guidedId(6, 'host-reboot', c.key),
    title: 'A host reboot flips MAC pinning',
    topology: T1.topology,
    options: c.options,
    durationS: END,
    timeline: [
      {
        at: T0,
        action: { kind: 'host.enter-maintenance', target: 'node-1' },
        note: 'Node 1 enters maintenance mode.',
      },
      { at: REBOOT_AT, action: { kind: 'reboot', target: 'node-1' }, note: 'Node 1 reboots.' },
      {
        at: EXIT_AT,
        action: { kind: 'host.exit-maintenance', target: 'node-1' },
        note: 'Node 1 leaves maintenance mode.',
      },
    ],
    expect: [
      ...guidedSteady(),
      atCtx(END, 'node 1 booted home', (_s, ctx) => {
        const pin = vswitch(snapshotAt(ctx, T0 - 1), T1.storageVs(1)).pinning;
        return pin[T1.segA(1)] === T1.storageNicA(1) && pin[T1.segB(1)] === T1.storageNicB(1);
      }),
      atCtx(END, 'and came back from the reboot swapped', (s) => {
        const pin = vswitch(s, T1.storageVs(1)).pinning;
        return pin[T1.segA(1)] === T1.storageNicB(1) && pin[T1.segB(1)] === T1.storageNicA(1);
      }),
      ...guideChecks(guide, END),
      ...baseInvariants(),
    ],
    guide,
    narrative: `With ${layoutWords(c)}, node 1 goes through a planned reboot: maintenance mode, reboot, back. OVS learns the storage interfaces afresh at every boot, in whatever order the NICs come up, so node 1 comes back swapped. ${four ? 'From then on all its storage IO crosses the ISL, and nothing reports it.' : 'With 8 array IPs that costs nothing.'}`,
    cite: ['ovs-bonding', 'ovs-bond-source', 'ntnx-ahv-admin-11.2'],
    status: 'active',
  });
}

const family: GuidedFamily = {
  n: 6,
  slug: 'host-reboot',
  title: 'A host reboot flips MAC pinning',
  configs: SLB_CONFIGS,
  build,
};
export default family;
