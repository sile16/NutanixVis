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
  fail: [
    { kind: 'switch.fail', target: SW_A },
    { kind: 'switch.fail', target: SW_B },
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
  // host; VMs may then be restarted after the network returns, hence the longer tail.
  const END =
    RESTORE_AT + (arrayOnly ? KATO + P.externalStorage.reconnectDelayS : P.ahvHa.restartByS) + 40;
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
      atCtx(
        RESTORE_AT,
        'cluster services stop (their volumes are on the array)',
        (s, ctx) =>
          derived(s).clusterServices === 'down' && eventSeen(ctx, 'cluster.services.down'),
      ),
      at(RESTORE_AT, 'no VM is serving IO during the outage', (s) =>
        allVms(s, (vm) => !isRunning(vm)),
      ),
      atCtx(
        RESTORE_AT,
        'no VM is restarted during the outage (no node has connectivity)',
        (_s, ctx) => !eventSeen(ctx, 'ha.vm.restarted'),
      ),
      ...(arrayOnly
        ? [
            alwaysFrom(T0, 'hosts stay connected (only the array is gone)', (s) =>
              hosts(s).every((h) => h.haState === 'connected'),
            ),
            at(RESTORE_AT, 'VMs stall in place, retrying until the array responds', (s) =>
              allVms(s, isStalled),
            ),
          ]
        : []),
      at(END, 'paths are back', (s) => allCvms(s, allPathsLive)),
      at(END, 'cluster services are back', (s) => derived(s).clusterServices === 'up'),
      allRunningAt(END),
      ...baseInvariants(),
    ],
    narrative: arrayOnly
      ? 'The whole FlashArray goes away. Every CVM loses every path, and the cluster services stop because their Cassandra, Curator and Zookeeper volumes live on the array. By default VM IO retries until the array responds, so VMs stall rather than fail, and resume once the array returns.'
      : 'Both switches fail. Storage and, in this cabling, management go with them, so no node can reach the array or its peers and cluster services stop. No VM can be restarted anywhere until the network returns.',
    cite: ['ntnx-ncp-everpure-deploy-7.6', 'ntnx-bible-8c', 'ntnx-bible-5b'],
    status: 'todo',
  });
}

export default [variant(SWITCHES), variant(ARRAY)];
