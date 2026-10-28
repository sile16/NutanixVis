import { defineScenario, type ScenarioDef } from '../define';
import {
  allCvms,
  allPathsLive,
  allVms,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  before,
  by,
  isRunning,
  isStalled,
  neverSeen,
  onlyPathsLostTo,
  SLACK,
  T0,
  t1Steady,
  vms,
  wasEver,
} from '../helpers';
import { linkId, SW_A, T1_LAB } from '../ids';
import { CQT, KATO, PATH_LOSS_RULE, PATH_LOSS_WORST } from '../timers';

/** The array port whose VLAN 10 is pruned: every CVM's path to this one IP goes silent. */
const FA_PORT = 'fa.ct0.eth10';
const IP = `${FA_PORT}.v10`;
const END = by(PATH_LOSS_WORST) + 20;

/**
 * Timing (SPEC §6.4c). The pruned VLAN drops frames silently, so each CVM declares its path to
 * `IP` lost KATO after the last keep-alive answer (≤ T0 + 1 + KATO), and commands stuck on it are
 * retried k × KATO + CQT after that answer, i.e. by T0 + 1 + PATH_LOSS_WORST. Until detection the
 * path still gets new IO. What the guest sees depends only on the path selector:
 * - queue-depth: the dead path's stuck commands make it the busiest, so it stops getting new IO.
 *   The guest keeps running with a few ~45 s outliers (partial stall).
 * - round-robin: a queue-depth-bound guest's slots all migrate onto the dead path, so it stalls
 *   completely from the first tick after the prune until the hold expires.
 */
function variant(selector: 'queue-depth' | 'round-robin'): ScenarioDef {
  const rr = selector === 'round-robin';
  return defineScenario({
    id: `t1lab-04-silent-path-loss-${selector}`,
    title: `T1-lab: one silent path loss under the ${selector} path selector`,
    topology: T1_LAB.topology,
    options: { 'nvme-path-selector': selector },
    durationS: END,
    timeline: [
      {
        at: T0,
        action: {
          kind: 'switch.port.prune-vlan',
          target: linkId(FA_PORT, SW_A),
          params: { vlan: 10 },
        },
        note: `Prune VLAN 10 from the switch port of array port ${FA_PORT}: no carrier loss, no reset.`,
      },
    ],
    expect: [
      ...t1Steady(),
      at(before(KATO), 'the initiators have not noticed yet', (s) => allCvms(s, allPathsLive)),
      at(by(KATO), 'every CVM loses exactly its path to that IP', (s) =>
        allCvms(s, (c) => onlyPathsLostTo(c, [IP])),
      ),
      alwaysFrom(T0, `no command waits longer than ${PATH_LOSS_RULE}`, (s) =>
        allVms(s, (v) => v.ioPendingS <= PATH_LOSS_WORST + SLACK),
      ),
      ...(rr
        ? [
            at(by(KATO), 'every VM is stalled: all its queue slots sit on the dead path', (s) =>
              allVms(s, isStalled),
            ),
            at(T0 + PATH_LOSS_WORST - SLACK - 2, 'and still stalled until the hold expires', (s) =>
              allVms(s, isStalled),
            ),
            at(by(PATH_LOSS_WORST), 'held commands retried on the live paths; VMs resume', (s) =>
              allVms(s, isRunning),
            ),
          ]
        : [
            alwaysFrom(T0, 'VMs keep running: only a few commands are stuck', (s) =>
              allVms(s, isRunning),
            ),
            atCtx(by(PATH_LOSS_WORST), 'the stuck commands are latency outliers', (_s, ctx) =>
              wasEver(ctx, (s) => vms(s).some((v) => v.ioPendingS > KATO + CQT), T0),
            ),
          ]),
      neverSeen(END, 'vm.io.guest-timeout'),
      ...baseInvariants(),
    ],
    narrative: rr
      ? `VLAN 10 is pruned from the switch port of array port ${FA_PORT}. Nothing loses carrier, so each CVM only learns its path to that IP is dead when keep-alive goes unanswered for KATO. Until then round-robin keeps sending it every Nth new command, and a guest that keeps its queue full re-issues each completed IO at once, so within moments all of its queue slots sit on the dead path. One silent path out of eight stalls every VM completely until the stuck commands are retried, 3 × KATO + CQT (about 45 s) after the last keep-alive.`
      : `VLAN 10 is pruned from the switch port of array port ${FA_PORT}. Nothing loses carrier, so each CVM only learns its path to that IP is dead when keep-alive goes unanswered for KATO. The queue-depth selector sends new IO to the path with the fewest outstanding commands, so the dead path, whose commands never complete, soon stops getting any. VMs keep running at a slightly lower effective queue depth; the few stuck commands are retried 3 × KATO + CQT (about 45 s) after the last keep-alive and show up as latency outliers.`,
    cite: ['nvme-base-spec-2.1', 'spdk-bdev-nvme-src', 'everpure-linux-dm-multipath'],
    status: 'active',
  });
}

export default [variant('queue-depth'), variant('round-robin')];
