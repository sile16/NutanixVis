/**
 * Guided 9: storage switch A fails (power loss: carrier drops everywhere), then returns. Every
 * topology loses the array paths through Switch A, so every one shows the same short partial
 * stall; what differs is what the hosts' NICs and bonds do, and what a switch return does to MAC
 * pinning (it heals a swapped node, docs/research/ovs-bond-behavior.md S7).
 */
import type { T1Config } from '../../topologies/t1-configs';
import { defineScenario, type GuideObservation, type ScenarioGuide } from '../define';
import { atCtx, baseInvariants, neverSeen, T0, vswitch } from '../helpers';
import { SW_A, T1 } from '../ids';
import { guideChecks } from '../steps';
import { P } from '../timers';
import { ALL_CONFIGS, type GuidedFamily, guidedId, guidedSteady, layoutWords, VM1 } from './kit';

const BACK_AT = T0 + 90;
const END = BACK_AT + 3 * P.bond.slbRebalanceIntervalS;

function hostSide(c: T1Config): string {
  if (c.bond === 'none') {
    return "On every node vs1's only uplink, eth2, loses carrier: storage-a's paths are gone, storage-b's carry on through eth3 and Switch B.";
  }
  const bond =
    c.bond === 'lacp'
      ? 'every bond drops eth2 from its aggregate and rehashes onto eth3'
      : "every bond moves its Switch A interface's MAC to eth3";
  return c.arrayIps === 4
    ? `On every node ${bond}, but storage-a's array ports are on Switch A, which is down: its paths are lost anyway. storage-b's carry on.`
    : `On every node ${bond}. The array ports on Switch A are gone, so each interface loses its paths there and keeps the two through Switch B.`;
}

function returnNote(c: T1Config): string {
  if (c.bond === 'none') return "Switch A is back: storage-a's paths reconnect and take IO again.";
  if (c.bond === 'lacp') {
    return 'Switch A is back: eth2 rejoins every aggregate and the paths through Switch A reconnect.';
  }
  return c.arrayIps === 4
    ? 'Switch A is back: eth2 rejoins every bond and the next rebalance pass moves the Switch A interface back onto it on every node, node 2 included: a switch return heals the swap node 2 booted with.'
    : 'Switch A is back: eth2 rejoins every bond, the next rebalance pass moves one interface back onto it on every node, and the paths through Switch A reconnect.';
}

function build(c: T1Config) {
  const groups: readonly (readonly GuideObservation[])[] = [
    [
      {
        stage: 'stall',
        step: 1,
        io: 'partial',
        text: 'Switch A fails. The commands queued on the paths through it stall (the VM shows the share); the rest of the IO completes through Switch B.',
      },
      { text: hostSide(c) },
      {
        stage: 'path-rerouted',
        step: 1,
        text: 'Keep-alive declares the Switch A paths lost: new IO goes through Switch B only.',
      },
      {
        stage: 'resumed',
        step: 2,
        text: 'The stuck commands are retried through Switch B: all IO completes again, at half the bandwidth.',
      },
    ],
    [{ stage: 'path-restored', text: returnNote(c) }],
  ];
  const guide: ScenarioGuide = { vm: VM1, groups };
  const healsSwap = c.bond === 'mac-pinning' && c.arrayIps === 4;
  return defineScenario({
    id: guidedId(9, 'switch', c.key),
    title: 'A storage switch fails',
    topology: T1.topology,
    options: c.options,
    durationS: END,
    timeline: [
      { at: T0, action: { kind: 'switch.fail', target: SW_A }, note: 'Switch A fails.' },
      { at: BACK_AT, action: { kind: 'recover', target: SW_A }, note: 'Switch A comes back.' },
    ],
    expect: [
      ...guidedSteady(),
      ...(healsSwap
        ? [
            atCtx(END, 'node 2 came back home after the switch returned', (s) => {
              const pin = vswitch(s, T1.storageVs(2)).pinning;
              return pin[T1.segA(2)] === T1.storageNicA(2) && pin[T1.segB(2)] === T1.storageNicB(2);
            }),
          ]
        : []),
      neverSeen(END, 'hades.maintenance.enter'),
      ...guideChecks(guide, END),
      ...baseInvariants(),
    ],
    guide,
    narrative: `With ${layoutWords(c)}, storage switch A fails. Every topology loses the array paths through it, so the VMs see the same short partial stall before keep-alive moves the IO through Switch B. ${healsSwap ? 'When the switch returns, MAC pinning moves every node back home, so the swap node 2 booted with is healed.' : 'When the switch returns its paths reconnect without a new stall.'}`,
    cite: ['everpure-nutanix-net-bp', 'ntnx-ahv-admin-11.2', 'ovs-bonding', 'nvme-base-spec-2.1'],
    status: 'active',
  });
}

const family: GuidedFamily = {
  n: 9,
  slug: 'switch',
  title: 'A storage switch fails',
  configs: ALL_CONFIGS,
  build,
};
export default family;
