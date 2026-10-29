import type { ActionRequest } from '../../engine/types';
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
import { HADES_DETECT, MOUNT_FAIL, P } from '../timers';

type Mode = 'short' | 'past-threshold' | 'port-flap';

/** Every NVMe/TCP data port of the array, both fabrics. */
const DATA_PORTS = [...T1.faIfacesA, ...T1.faIfacesB];
const FLAP_S = 3;

/**
 * A short whole-array outage (SPEC §6.2 "Hades service volumes", §6.4 "T1 full array loss"). The
 * outcome depends on how the paths end and on the multipath fast-IO-fail time, not on the outage
 * length against a Hades timer.
 * - `short`: the array goes silent (no TCP resets) and is back before every path has been gone
 *   `MOUNT_FAIL`. Multipath queues the service-volume IO, the mounts stay healthy: a plain stall,
 *   a little longer than the outage while paths reconnect, and the VMs survive.
 * - `past-threshold`: the same silent loss, back just after `MOUNT_FAIL` (before Hades acts). The
 *   IO has failed, the mounts stay bad, so every node enters maintenance, every Stargate restarts
 *   (`hades.servicesRestartS`, longer than the initiator session timeout), and every VM crashes and
 *   is powered back on.
 * - `port-flap`: every data port flaps for a few seconds, well under the silent threshold. When the
 *   ports return the array resets every connection, so the IO errors at once and the mounts go bad
 *   at once: the same cluster-wide maintenance and VM crashes. One fabric's ports flapping alone is
 *   harmless (the other fabric keeps the mounts healthy; T1-23).
 */
function variant(mode: Mode): ScenarioDef {
  const crash = mode !== 'short';
  const flap = mode === 'port-flap';
  const BACK_AT = flap
    ? T0 + 1 + FLAP_S
    : mode === 'past-threshold'
      ? T0 + MOUNT_FAIL + 2
      : T0 + MOUNT_FAIL - 3;
  const MAINT_BY = flap
    ? BACK_AT + 2 + P.hades.volumeMonitorIntervalS + P.hades.externalStorageErrorThresholdS
    : by(HADES_DETECT);
  const END = crash
    ? MAINT_BY +
      P.hades.volumeMonitorIntervalS +
      P.hades.servicesRestartS +
      2 * P.ahvHa.heartbeatIntervalS +
      30
    : BACK_AT + 60;
  const timeline: { at: number; action: ActionRequest; note: string }[] = flap
    ? DATA_PORTS.map((target) => ({
        at: T0,
        action: { kind: 'fa.interface.flap', target, params: { durationS: FLAP_S } },
        note: `Data port ${target} loses link for ${FLAP_S} s.`,
      }))
    : [
        { at: T0, action: { kind: 'fail', target: FA }, note: 'The array goes silent.' },
        {
          at: BACK_AT,
          action: { kind: 'recover', target: FA },
          note: crash ? 'Back just after the mounts failed.' : 'Back before the mounts fail.',
        },
      ];
  const title =
    mode === 'short'
      ? 'a silent whole-array blip shorter than the fast-IO-fail time'
      : mode === 'past-threshold'
        ? 'a silent whole-array blip just past the fast-IO-fail time'
        : `every array data port flaps for ${FLAP_S} s`;
  return defineScenario({
    id: `t1-28-whole-array-blip-${mode}`,
    title: `T1: ${title}`,
    topology: T1.topology,
    durationS: END,
    timeline,
    expect: [
      ...t1Steady(),
      at(BACK_AT - 1, 'VM IO is stalled everywhere during the blip', (s) =>
        allVms(s, (v) => !isRunning(v)),
      ),
      ...(crash
        ? [
            atCtx(
              MAINT_BY,
              'every node enters maintenance after the array is back: the mounts stayed bad',
              (s, ctx) =>
                cvms(s).every((c) => {
                  const t = firstEventAt(ctx, 'hades.maintenance.enter', { device: c.id });
                  return t !== null && t >= BACK_AT;
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
            atCtx(END, 'AHV powers them back on once the Stargates serve again', (s, ctx) =>
              vms(s).every((v) => eventSeen(ctx, 'ha.vm.restarted', { device: v.id })),
            ),
          ]
        : [
            neverSeen(END, 'hades.maintenance.enter'),
            neverSeen(END, 'vm.crashed'),
            at(BACK_AT + 30, 'VMs resume in place on their own hosts', (s) =>
              allVms(s, (v) => isRunning(v) && v.host === v.id.split('.')[0]),
            ),
          ]),
      allRunningAt(END),
      ...baseInvariants(),
    ],
    narrative:
      mode === 'short'
        ? 'The array goes silent for a few seconds, less than the multipath fast-IO-fail time. Multipath queues the service-volume IO instead of failing it, so the mounts never go bad and Hades does nothing. VM IO stalls a little longer than the outage while the paths reconnect, then resumes in place: no maintenance, no crash.'
        : mode === 'past-threshold'
          ? 'The array goes silent and comes back just after the multipath fast-IO-fail time, before Hades has acted. The service-volume IO has already failed, so the mounts stay bad and every node enters Hades maintenance at its next volume check, even though the array is back. Every Stargate restarts, which takes longer than the initiator session timeout, so every VM crashes and AHV powers it back on once the Stargates serve again.'
          : `Every array data port on both fabrics loses link for ${FLAP_S} s. When the ports return, the array resets every connection, so the service-volume IO errors at once instead of queueing and the mounts go bad on every node, however short the flap. Every node enters Hades maintenance, every Stargate restarts for longer than the initiator session timeout, and every VM crashes and is powered back on.`,
    cite: ['ntnx-ncp-everpure-deploy-7.6', 'everpure-linux-dm-multipath', 'ntnx-cmdref-aos-7.6'],
    status: 'active',
  });
}

export default [variant('short'), variant('past-threshold'), variant('port-flap')];
