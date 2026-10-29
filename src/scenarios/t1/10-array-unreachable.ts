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
  isStalled,
  neverSeen,
  T0,
  t1Steady,
} from '../helpers';
import { FA, SW_A, SW_B, T1 } from '../ids';
import { HADES_DETECT, HADES_EXIT, HADES_RECOVER, KATO, P, t1Tolerance } from '../timers';

const RESTORE_AT = T0 + 120;
/** Nodes the cluster lets into maintenance at once: its N−2 tolerance on 4 nodes. */
const MAINT_SLOTS = t1Tolerance(T1.nodes.length);

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
  // Hades maintenance mode by HADES_DETECT, but maintenance takes a node out of the cluster and
  // only N−2 are admitted; the others keep retrying with Stargate up. Both variants recover the
  // same way: paths reconnect, the next volume check takes the nodes in maintenance out of it
  // (HADES_EXIT, not the 300 s re-map), their services restart (servicesRestartS), and the
  // stalled VMs resume on their own hosts.
  const ZK_DOWN = KATO + P.cluster.zkSessionTimeoutS;
  const END = by(HADES_RECOVER, RESTORE_AT) + 10;
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
      atCtx(
        by(HADES_DETECT),
        'every node tries maintenance mode, but the cluster admits only N−2; the rest keep trying',
        (s, ctx) => {
          const ids = cvms(s).map((c) => c.id);
          const entered = ids.filter((id) =>
            eventSeen(ctx, 'hades.maintenance.enter', { device: id }),
          );
          const refused = ids.filter((id) =>
            eventSeen(ctx, 'hades.maintenance.refused', { device: id }),
          );
          return entered.length === MAINT_SLOTS && refused.length === ids.length - MAINT_SLOTS;
        },
      ),
      alwaysFrom(
        by(ZK_DOWN),
        'cluster services stay down while the array is gone',
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
      // The outage is shorter than guest.ioStallCrashS: VMs only stall (see T1-27 for longer).
      neverSeen(END, 'vm.crashed'),
      at(END, 'paths are back', (s) => allCvms(s, allPathsLive)),
      at(END, 'cluster services are back', (s) => derived(s).clusterServices === 'up'),
      allRunningAt(END),
      ...baseInvariants(),
    ],
    narrative: arrayOnly
      ? 'The whole FlashArray goes away. Every CVM loses every path, including its Cassandra and Zookeeper service volumes, so the cluster services and Prism Element go down and every node tries to enter Hades maintenance mode, but the cluster admits only as many as it tolerates and the rest keep trying. VM IO retries, so for an outage this short VMs stall rather than fail. Once the array is back, paths reconnect, the next volume check takes the nodes out of maintenance, their services restart and the VMs resume on their own hosts.'
      : 'Both switches fail. Storage and, in this cabling, management go with them, so every CVM loses every NVMe path and no node can reach its peers. With no Zookeeper majority anywhere and every node stuck in or trying to enter Hades maintenance mode, cluster services stop and the Acropolis leader is gone, so no host is fenced and no VM is restarted. VM IO retries until storage responds, so the VMs stall in place and resume once the switches return and the services restart.',
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
