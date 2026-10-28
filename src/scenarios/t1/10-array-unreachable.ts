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
  firstEventAt,
  hosts,
  isRunning,
  isStalled,
  neverSeen,
  T0,
  t1Steady,
} from '../helpers';
import { FA, SW_A, SW_B, T1 } from '../ids';
import { HADES_DETECT, HADES_RECOVER, KATO, P } from '../timers';

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
  // host. No side then has a ZK majority, so nobody fences or restarts (SPEC §14 #1). Timing
  // (`inferred`): every CVM loses its service volumes at KATO, so ZK has no live majority at
  // once and cluster services are declared down a ZK session timeout later; Hades puts every
  // node in maintenance mode by HADES_DETECT. Both variants recover the same way: paths
  // reconnect while in maintenance, the next periodic re-map (mapNvmfVolumesIntervalS after
  // maintenance began) restarts the services (cvmBootS), and the stalled VMs resume in place.
  const ZK_DOWN = KATO + P.cluster.zkSessionTimeoutS;
  const SERVICES_BACK = T0 + 1 + KATO + HADES_RECOVER;
  const END = by(HADES_DETECT + HADES_RECOVER) + 10;
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
        by(ZK_DOWN),
        'cluster services stop (their volumes are on the array); Prism Element is unreachable',
        (s, ctx) =>
          derived(s).clusterServices === 'down' &&
          s.derived.prismElement === 'unreachable' &&
          s.derived.prismCentralAlert === 'A200000' &&
          eventSeen(ctx, 'cluster.services.down'),
      ),
      atCtx(by(HADES_DETECT), 'Hades puts every node in maintenance mode', (s, ctx) =>
        allCvms(s, (c) => eventSeen(ctx, 'hades.maintenance.enter', { device: c.id })),
      ),
      alwaysFrom(
        by(ZK_DOWN),
        'cluster services stay down until the re-map restarts them',
        (s) => s.simTime > SERVICES_BACK || derived(s).clusterServices === 'down',
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
      atCtx(
        END,
        'services restart at the first periodic re-map after the array returns',
        (_s, ctx) =>
          [1, 2, 3, 4].every((n) => {
            const id = `node-${n}.cvm`;
            const entered = firstEventAt(ctx, 'hades.maintenance.enter', { device: id });
            const remapped = firstEventAt(ctx, 'hades.volumes.remapped', { device: id });
            return entered !== null && remapped === entered + P.hades.mapNvmfVolumesIntervalS;
          }),
      ),
      at(END, 'paths are back', (s) => allCvms(s, allPathsLive)),
      at(END, 'cluster services are back', (s) => derived(s).clusterServices === 'up'),
      allRunningAt(END),
      ...baseInvariants(),
    ],
    narrative: arrayOnly
      ? 'The whole FlashArray goes away. Every CVM loses every path, including its Cassandra and Zookeeper service volumes, so Hades puts every node in maintenance mode and the cluster services and Prism Element go down. VM IO retries until the array responds, so VMs stall rather than fail. Once the array is back, the next periodic re-map restarts the services and the VMs resume in place.'
      : 'Both switches fail. Storage and, in this cabling, management go with them, so every CVM loses every NVMe path and no node can reach its peers. With no Zookeeper majority anywhere and every node in Hades maintenance mode, cluster services stop and the Acropolis leader is gone, so no host is fenced and no VM is restarted. VM IO retries until storage responds, so the VMs stall in place and resume after the next re-map once the switches return.',
    cite: [
      'ntnx-ncp-everpure-deploy-7.6',
      'ntnx-bible-8c',
      'ntnx-bible-5b',
      'ntnx-cmdref-aos-7.6',
      'ntnx-pc-alerts-7.6-cluster',
    ],
    status: 'active',
  });
}

export default [variant(SWITCHES), variant(ARRAY)];
