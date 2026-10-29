import { defineScenario, type ScenarioDef } from '../define';
import {
  allRunningAt,
  allVms,
  at,
  atCtx,
  baseInvariants,
  by,
  cvms,
  eventSeen,
  firstEventAt,
  isRunning,
  neverSeen,
  T0,
  t1Steady,
  vms,
} from '../helpers';
import { FA, T1 } from '../ids';
import { HADES_DETECT, HADES_EARLIEST, MOUNT_FAIL, P } from '../timers';

type Mode = 'short' | 'past-threshold';

/**
 * A short whole-array blip (SPEC §6.2 "Hades service volumes", §6.4 "T1 full array loss"). What
 * decides the outcome is the multipath fast-IO-fail time, not the outage length against a Hades
 * timer: once every path has been gone `MOUNT_FAIL` after the loss, the service-volume IO fails
 * and the mounts stay bad even after the array returns.
 * - `short`: the array is back before that, so it is a plain stall and the VMs survive.
 * - `past-threshold`: the array is back just after it (before Hades acts), yet every node enters
 *   maintenance at its next volume check, every Stargate restarts (`hades.servicesRestartS`),
 *   which outlasts the initiator session timeout, so every VM crashes and is powered back on.
 */
function variant(mode: Mode): ScenarioDef {
  const past = mode === 'past-threshold';
  const RESTORE_AT = past ? T0 + MOUNT_FAIL + 2 : T0 + MOUNT_FAIL - 3;
  const END = past
    ? by(
        HADES_DETECT +
          P.hades.volumeMonitorIntervalS +
          P.hades.servicesRestartS +
          2 * P.ahvHa.heartbeatIntervalS,
      ) + 30
    : RESTORE_AT + 60;
  return defineScenario({
    id: `t1-28-whole-array-blip-${mode}`,
    title: `T1: a whole-array blip ${past ? 'just past' : 'shorter than'} the fast-IO-fail time`,
    topology: T1.topology,
    durationS: END,
    timeline: [
      { at: T0, action: { kind: 'fail', target: FA }, note: 'The whole FlashArray goes away.' },
      {
        at: RESTORE_AT,
        action: { kind: 'recover', target: FA },
        note: past ? 'Back just after the mounts failed.' : 'Back before the mounts fail.',
      },
    ],
    expect: [
      ...t1Steady(),
      at(RESTORE_AT - 1, 'VM IO is stalled everywhere during the blip', (s) =>
        allVms(s, (v) => !isRunning(v)),
      ),
      ...(past
        ? [
            atCtx(
              by(HADES_DETECT),
              'every node enters maintenance after the array is back: the mounts stayed bad',
              (s, ctx) =>
                cvms(s).every((c) => {
                  const t = firstEventAt(ctx, 'hades.maintenance.enter', { device: c.id });
                  return t !== null && t >= T0 + HADES_EARLIEST && t > RESTORE_AT;
                }),
            ),
            atCtx(
              END,
              'with every Stargate restarting, every VM crashes at the initiator session timeout',
              (s, ctx) =>
                vms(s).every((v) => eventSeen(ctx, 'vm.crashed', { device: v.id })) &&
                (firstEventAt(ctx, 'vm.crashed') ?? 0) >=
                  T0 + P.redirector.initiatorSessionTimeoutS,
            ),
            atCtx(END, 'AHV powers them back on once the Stargates serve again', (_s, ctx) =>
              vms(_s).every((v) => eventSeen(ctx, 'ha.vm.restarted', { device: v.id })),
            ),
          ]
        : [
            neverSeen(END, 'hades.maintenance.enter'),
            neverSeen(END, 'vm.crashed'),
            at(RESTORE_AT + 30, 'VMs resume in place on their own hosts', (s) =>
              allVms(s, (v) => isRunning(v) && v.host === v.id.split('.')[0]),
            ),
          ]),
      allRunningAt(END),
      ...baseInvariants(),
    ],
    narrative: past
      ? 'The whole FlashArray goes away and comes back just after the multipath fast-IO-fail time, before Hades has acted. The service-volume IO has already failed, so the mounts stay bad and every node enters Hades maintenance at its next volume check, even though the array is back. Every Stargate restarts, which takes longer than the initiator session timeout, so every VM crashes and AHV powers it back on once the Stargates serve again.'
      : 'The whole FlashArray goes away for a few seconds, less than the multipath fast-IO-fail time. Multipath queues the service-volume IO instead of failing it, so the mounts never go bad and Hades does nothing. VM IO stalls and then resumes in place: no maintenance, no crash.',
    cite: ['ntnx-ncp-everpure-deploy-7.6', 'everpure-linux-dm-multipath', 'ntnx-cmdref-aos-7.6'],
    status: 'active',
  });
}

export default [variant('short'), variant('past-threshold')];
