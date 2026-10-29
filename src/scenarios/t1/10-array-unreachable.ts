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
  cvms,
  derived,
  eventSeen,
  firstEventAt,
  hosts,
  isRunning,
  neverSeen,
  T0,
  t1Steady,
  vms,
} from '../helpers';
import { FA, SW_A, SW_B, T1 } from '../ids';
import { HADES_DETECT, HADES_EXIT, HADES_RECOVER, KATO, P } from '../timers';

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
  // once and cluster services are declared down a ZK session timeout later; every node attempts
  // Hades maintenance mode by HADES_DETECT; each node decides on its own volumes, so every node
  // enters it and no Stargate is left to serve. Once no Stargate has served them for the
  // initiator session timeout the VMs crash (SPEC §6.2 "iSCSI redirector"). Both variants
  // recover the same way: paths reconnect, the next volume check takes the nodes out of
  // maintenance (HADES_EXIT, not the 300 s re-map), their services restart (servicesRestartS),
  // an Acropolis leader acts again and AHV powers the VMs back on.
  const ZK_DOWN = KATO + P.cluster.zkSessionTimeoutS;
  const END = by(HADES_RECOVER, RESTORE_AT) + 30;
  const CRASH_BY = HADES_DETECT + P.redirector.initiatorSessionTimeoutS;
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
      atCtx(by(HADES_DETECT), 'every node enters Hades maintenance mode', (s, ctx) =>
        cvms(s).every((c) => eventSeen(ctx, 'hades.maintenance.enter', { device: c.id })),
      ),
      alwaysFrom(
        by(ZK_DOWN),
        'cluster services stay down while the array is gone',
        (s) => s.simTime > RESTORE_AT || derived(s).clusterServices === 'down',
      ),
      at(RESTORE_AT, 'no VM is serving IO during the outage', (s) =>
        allVms(s, (vm) => !isRunning(vm)),
      ),
      atCtx(
        by(CRASH_BY),
        'with no Stargate left to serve, every VM crashes at the initiator session timeout',
        (s, ctx) =>
          allVms(s, (vm) => vm.host === null) &&
          vms(s).every((vm) => {
            const t = firstEventAt(ctx, 'vm.crashed', { device: vm.id });
            return t !== null && t >= T0 + P.redirector.initiatorSessionTimeoutS;
          }),
      ),
      at(RESTORE_AT, 'crashed VMs stay down while storage is gone', (s) =>
        allVms(s, (vm) => vm.host === null),
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
      atCtx(END, 'AHV powers the VMs back on only after storage returns', (_s, ctx) => {
        const first = firstEventAt(ctx, 'ha.vm.restarted');
        return first !== null && first > RESTORE_AT;
      }),
      atCtx(
        END,
        'nodes in maintenance leave it at the first volume check after the paths return',
        (_s, ctx) =>
          [1, 2, 3, 4].every((n) => {
            const id = `node-${n}.cvm`;
            const entered = firstEventAt(ctx, 'hades.maintenance.enter', { device: id });
            const exit = firstEventAt(ctx, 'hades.maintenance.exit', { device: id });
            return (
              entered === null ||
              (exit !== null && exit > RESTORE_AT && exit <= by(HADES_EXIT, RESTORE_AT))
            );
          }),
      ),
      at(END, 'paths are back', (s) => allCvms(s, allPathsLive)),
      at(END, 'cluster services are back', (s) => derived(s).clusterServices === 'up'),
      allRunningAt(END),
      ...baseInvariants(),
    ],
    narrative: arrayOnly
      ? 'The whole FlashArray goes away. Every CVM loses every path, including its Cassandra and Zookeeper service volumes, so the cluster services and Prism Element go down and every node enters Hades maintenance mode, which stops its Stargate. With no Stargate left to serve them, the iSCSI initiators of the VMs give up after their session timeout and the VMs crash. Once the array is back, paths reconnect, the next volume check takes the nodes out of maintenance, their services restart and AHV powers the VMs back on.'
      : 'Both switches fail. Storage and, in this cabling, management go with them, so every CVM loses every NVMe path and no node can reach its peers. With no Zookeeper majority anywhere and every node in Hades maintenance mode, cluster services stop and the Acropolis leader is gone, so no host is fenced. No Stargate is left to serve the VMs, so they crash at the initiator session timeout and stay down until the switches return, the services restart and AHV powers them back on.',
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
