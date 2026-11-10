/**
 * Guided 1: one FlashArray data port fails. Pure NVMe/TCP multipathing, as on any FlashArray
 * host: the host side (bond, vSwitch, switches) sees nothing.
 */
import type { T1Config } from '../../topologies/t1-configs';
import { defineScenario, type ScenarioGuide } from '../define';
import { alwaysFrom, atCtx, baseInvariants, faController, neverSeen, T0 } from '../helpers';
import { CT0, T1 } from '../ids';
import { guideChecks } from '../steps';
import { ALL_CONFIGS, type GuidedFamily, guidedId, guidedSteady, layoutWords, VM1 } from './kit';

const PORT = 'fa.ct0.eth10';
const BACK_AT = T0 + 90;
const END = BACK_AT + 40;

function build(c: T1Config) {
  const eight = c.arrayIps === 8;
  const paths = eight ? 'two of its eight paths (one per storage VLAN)' : 'one of its four paths';
  const them = eight ? 'them' : 'it';
  const guide: ScenarioGuide = {
    vm: VM1,
    groups: [
      [
        {
          stage: 'stall',
          step: 1,
          io: 'partial',
          text: `CT0 eth10 goes dark. Each CVM loses ${paths}: only the commands already queued there stall (the VM shows the share), the rest of the IO completes on the other paths.`,
        },
        {
          stage: 'path-rerouted',
          step: 1,
          text: `Keep-alive declares ${them} lost: new IO goes only to the remaining paths.`,
        },
        {
          stage: 'resumed',
          step: eight ? 1 : 2,
          text: 'The stuck commands are retried on the other paths: all IO completes again. CT0 stays primary and keeps serving on its other port; nothing fails over.',
        },
        {
          text:
            c.bond === 'none'
              ? 'The host side sees nothing: both NICs, both vSwitches and both switches stay healthy. This is plain NVMe multipathing, as on any FlashArray host.'
              : 'The host side sees nothing: the bond, its members and both switches stay healthy. This is plain NVMe multipathing, as on any FlashArray host.',
        },
      ],
      [
        {
          stage: 'path-restored',
          text: `eth10 is back: ${eight ? 'its paths reconnect' : 'its path reconnects'} and take IO again, with no new stall.`,
        },
      ],
    ],
  };
  return defineScenario({
    id: guidedId(1, 'array-port', c.key),
    title: 'One array port fails',
    topology: T1.topology,
    options: c.options,
    durationS: END,
    timeline: [
      { at: T0, action: { kind: 'fail', target: PORT }, note: 'Array port CT0 eth10 fails.' },
      { at: BACK_AT, action: { kind: 'recover', target: PORT }, note: 'CT0 eth10 comes back.' },
    ],
    expect: [
      ...guidedSteady(),
      alwaysFrom(
        T0,
        'CT0 stays primary: a port failure fails no controller over',
        (s) => faController(s, CT0).role === 'primary',
      ),
      atCtx(END, 'every path is live again after the port returns', (s) =>
        Object.values(s.devices).every(
          (d) => d.kind !== 'cvm' || !String(d.fields.nvmePaths ?? '').includes('"lost"'),
        ),
      ),
      neverSeen(END, 'net.bond.failover'),
      neverSeen(END, 'hades.maintenance.enter'),
      ...guideChecks(guide, END),
      ...baseInvariants(),
    ],
    guide,
    narrative: `With ${layoutWords(c)}, one array data port fails. Each CVM loses ${paths}, only the commands queued there stall, and keep-alive moves the IO to the remaining paths within a step or two. Nothing on the hosts or switches changes, and the controller does not fail over.`,
    cite: ['nvme-base-spec-2.1', 'spdk-nvme-multipath', 'everpure-nutanix-301-deck'],
    status: 'active',
  });
}

const family: GuidedFamily = {
  n: 1,
  slug: 'array-port',
  title: 'One array port fails',
  configs: ALL_CONFIGS,
  build,
};
export default family;
