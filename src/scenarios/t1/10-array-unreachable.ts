import type { ActionRequest } from '../../engine/types';
import { defineScenario, type ScenarioDef } from '../define';
import {
  allCvms,
  allPathsLive,
  allRunningAt,
  allVms,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  by,
  cvmPathsUp,
  derived,
  eventSeen,
  hosts,
  isRunning,
  isStalled,
  neverSeen,
  T0,
  t1Steady,
} from '../helpers';
import { FA, SW_A, SW_B, T1 } from '../ids';
import { KATO, P } from '../timers';

const RESTORE_AT = T0 + 120;

interface Variant {
  readonly key: string;
  readonly title: string;
  readonly fail: readonly ActionRequest[];
  readonly restore: readonly ActionRequest[];
}

const SWITCHES: Variant = {
  key: 'both-switches',
  title: 'both storage switches fail',
  // Generic hard `fail` on each switch (the engine has no `switch.fail` kind; SPEC §5.5 lists it).
  fail: [
    { kind: 'fail', target: SW_A },
    { kind: 'fail', target: SW_B },
  ],
  restore: [
    { kind: 'recover', target: SW_A },
    { kind: 'recover', target: SW_B },
  ],
};

const ARRAY: Variant = {
  key: 'array-lost',
  title: 'the whole array is lost',
  fail: [{ kind: 'fail', target: FA }],
  restore: [{ kind: 'recover', target: FA }],
};

function variant(v: Variant): ScenarioDef {
  const arrayOnly = v === ARRAY;
  // In the default topology vs0 shares Switch A/B, so losing both switches also isolates every
  // host. No side then has a ZK majority, so nobody fences or restarts (SPEC §14 #1) and both
  // variants recover the same way: paths reconnect within KATO + reconnectDelayS, cluster
  // services restart, and the stalled VMs resume in place.
  const END = RESTORE_AT + KATO + P.externalStorage.reconnectDelayS + 40;
  return defineScenario({
    id: `t1-10-${v.key}`,
    title: `T1: ${v.title}`,
    topology: T1.topology,
    durationS: END,
    timeline: [
      ...v.fail.map((action) => ({ at: T0, action })),
      ...v.restore.map((action) => ({ at: RESTORE_AT, action })),
    ],
    expect: [
      ...t1Steady(),
      at(by(KATO), 'every CVM has lost every NVMe path', (s) =>
        allCvms(s, (c) => cvmPathsUp(s, c.id) === 0),
      ),
      // Model timing (`inferred`): the services' volumes are unreachable once every path is
      // lost (KATO); with both switches gone ZK also loses its majority at once.
      atCtx(
        by(KATO),
        'cluster services stop (their volumes are on the array)',
        (s, ctx) =>
          derived(s).clusterServices === 'down' && eventSeen(ctx, 'cluster.services.down'),
      ),
      alwaysFrom(
        by(KATO),
        'cluster services stay down until the fabric/array returns',
        (s) => s.simTime > RESTORE_AT || derived(s).clusterServices === 'down',
      ),
      at(RESTORE_AT, 'no VM is serving IO during the outage', (s) =>
        allVms(s, (vm) => !isRunning(vm)),
      ),
      // DEPLOY-GUIDE: IO retries until the array responds; SPEC §14 #1 for the switch variant.
      at(RESTORE_AT, 'VMs stall in place, retrying until storage responds', (s) =>
        allVms(s, (vm) => isStalled(vm) && vm.host === vm.id.split('.')[0]),
      ),
      ...(arrayOnly
        ? [
            alwaysFrom(T0, 'hosts stay connected (only the array is gone)', (s) =>
              hosts(s).every((h) => h.haState === 'connected'),
            ),
          ]
        : [
            at(
              RESTORE_AT,
              'no side has ZK quorum, so no Acropolis leader acts',
              (s) => derived(s).zkQuorum === false && derived(s).acropolisLeader === null,
            ),
            alwaysFrom(T0, 'no host is fenced (no quorum anywhere)', (s) =>
              hosts(s).every((h) => h.haState !== 'fenced'),
            ),
          ]),
      neverSeen(END, 'ha.host.fenced'),
      neverSeen(END, 'ha.vm.self-terminated'),
      neverSeen(END, 'ha.vm.restarted'),
      at(END, 'paths are back', (s) => allCvms(s, allPathsLive)),
      at(END, 'cluster services are back', (s) => derived(s).clusterServices === 'up'),
      allRunningAt(END),
      ...baseInvariants(),
    ],
    narrative: arrayOnly
      ? 'The whole FlashArray goes away. Every CVM loses every path, and the cluster services stop because their Cassandra, Curator and Zookeeper volumes live on the array. By default VM IO retries until the array responds, so VMs stall rather than fail, and resume once the array returns.'
      : 'Both switches fail. Storage and, in this cabling, management go with them, so every CVM loses every NVMe path and no node can reach its peers. With no Zookeeper majority anywhere, cluster services stop and the Acropolis leader is gone, so no host is fenced and no VM is restarted. VM IO retries until storage responds, so the VMs stall in place and resume once the switches return.',
    cite: ['ntnx-ncp-everpure-deploy-7.6', 'ntnx-bible-8c', 'ntnx-bible-5b'],
    status: 'active',
  });
}

export default [variant(SWITCHES), variant(ARRAY)];
