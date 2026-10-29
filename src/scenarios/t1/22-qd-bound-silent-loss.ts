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
import { linkId, SW_A, T1 } from '../ids';
import { CQT, KATO, P, PATH_LOSS_RULE, PATH_LOSS_WORST } from '../timers';

/** The array port whose VLAN 10 is pruned: every CVM's path to this one IP goes silent. */
const FA_PORT = 'fa.ct0.eth10';
const IP = `${FA_PORT}.v10`;
const END = by(PATH_LOSS_WORST) + 20;

/**
 * SPEC §6.4c item 3, queue-depth selector (the default). Until the silent path is declared lost,
 * new IO still goes to it: a dead IO queue at depth 0 ties with the live ones, so each of the dead
 * path's `ioQueuesPerPath` queues takes a command of the guest before it looks busier than the
 * live queues. A guest with no more queue slots than that has every slot stuck: it stalls
 * completely until the stuck commands are abandoned (k × KATO + CQT after the last exchange) and
 * retried on the surviving paths, with no guest error. A deeper queue keeps running (partial).
 */
function variant(qd: 4 | 32): ScenarioDef {
  const bound = qd <= P.externalStorage.ioQueuesPerPath;
  return defineScenario({
    id: `t1-22-silent-path-loss-qd${qd}`,
    title: `T1: one silent path loss with a guest queue depth of ${qd} (queue-depth selector)`,
    topology: T1.topology,
    options: { 'guest-queue-depth': qd },
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
      ...(bound
        ? [
            at(by(KATO), 'every VM is stalled: each queue slot sits on a dead IO queue', (s) =>
              allVms(s, isStalled),
            ),
            at(T0 + PATH_LOSS_WORST - SLACK - 2, 'still stalled: nothing completes', (s) =>
              allVms(s, isStalled),
            ),
            at(by(PATH_LOSS_WORST), 'abandoned commands retried on the surviving paths', (s) =>
              allVms(s, isRunning),
            ),
          ]
        : [
            alwaysFrom(T0, 'VMs keep running: only a few of their slots are stuck', (s) =>
              allVms(s, isRunning),
            ),
            atCtx(by(PATH_LOSS_WORST), 'the stuck commands are latency outliers', (_s, ctx) =>
              wasEver(ctx, (s) => vms(s).some((v) => v.ioPendingS > KATO + CQT), T0),
            ),
          ]),
      neverSeen(END, 'vm.io.guest-timeout'),
      neverSeen(END, 'vm.io.error'),
      ...baseInvariants(),
    ],
    narrative: bound
      ? `VLAN 10 is pruned from the switch port of array port ${FA_PORT}, so every CVM's path to that IP goes silent and is declared lost only when keep-alive goes unanswered. Until then new IO still goes to it: each of its IO queues looks idle and takes one of the guest's commands, and with a queue depth of ${qd} that is every slot, so the guest stalls completely even under the queue-depth selector. The stuck commands are abandoned about 45 s after the last keep-alive (${PATH_LOSS_RULE}) and retried on the surviving paths, with no error reaching the guest.`
      : `The same silent path loss with a guest that keeps ${qd} IOs outstanding. The dead path's IO queues each take one command before they look busier than the live ones, which leaves the guest most of its slots, so it keeps running with a few commands stuck until they are abandoned about 45 s later. That is the partial stall a deep queue sees.`,
    cite: ['nvme-base-spec-2.1', 'spdk-bdev-nvme-src', 'everpure-linux-dm-multipath'],
    status: 'active',
  });
}

export default [variant(4), variant(32)];
