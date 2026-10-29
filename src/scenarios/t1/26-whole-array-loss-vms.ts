import { defineScenario, type ScenarioDef } from '../define';
import {
  allRunningAt,
  allVms,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  by,
  cvms,
  eventSeen,
  eventsMatching,
  firstEventAt,
  isStalled,
  neverSeen,
  T0,
  t1Steady,
  vms,
} from '../helpers';
import { FA, T1 } from '../ids';
import { HADES_DETECT, HADES_RECOVER, P, t1Tolerance } from '../timers';

const RESTORE_AT = T0 + 300;
const CRASH = P.guest.ioStallCrashS;
const SLOTS = t1Tolerance(T1.nodes.length);
const END = by(HADES_RECOVER + P.ahvHa.restartByS, RESTORE_AT) + 30;

/**
 * Whole-array loss for longer than a guest can wait (SPEC §6.4 "T1 full array loss", §14).
 * Every CVM loses every path and its service volumes; every node tries Hades maintenance mode but
 * only N−2 are admitted, the rest keep trying. VM IO stalls everywhere.
 * - `crash-and-restart` (default, `assumption`): once a VM's IO has stalled `guest.ioStallCrashS`
 *   it crashes (QEMU exits, "VM shut down unexpectedly"). Nothing restarts it while the array is
 *   gone (no cluster services, no Acropolis leader); after the array returns and the services
 *   re-form, AHV HA restarts the VMs on hosts whose CVM reaches the array.
 * - `stall`: the DEPLOY-GUIDE wording taken literally: IO retries until the array responds.
 */
function variant(mode: 'crash-and-restart' | 'stall'): ScenarioDef {
  const crash = mode === 'crash-and-restart';
  return defineScenario({
    id: `t1-26-whole-array-loss-${mode}`,
    title: `T1: the whole array is lost for minutes (${mode})`,
    topology: T1.topology,
    options: { 'whole-array-loss-vm-behavior': mode },
    durationS: END,
    timeline: [
      { at: T0, action: { kind: 'fail', target: FA }, note: 'The whole FlashArray goes away.' },
      { at: RESTORE_AT, action: { kind: 'recover', target: FA }, note: 'The array is back.' },
    ],
    expect: [
      ...t1Steady(),
      atCtx(by(HADES_DETECT), 'every node tries maintenance; only N−2 are admitted', (s, ctx) => {
        const ids = cvms(s).map((c) => c.id);
        const entered = ids.filter((id) =>
          eventSeen(ctx, 'hades.maintenance.enter', { device: id }),
        );
        const refused = ids.filter((id) =>
          eventSeen(ctx, 'hades.maintenance.refused', { device: id }),
        );
        return entered.length === SLOTS && refused.length === ids.length - SLOTS;
      }),
      at(T0 + CRASH - 5, 'VM IO is stalled everywhere', (s) => allVms(s, isStalled)),
      ...(crash
        ? [
            atCtx(
              RESTORE_AT,
              `every VM crashed once its IO had stalled ${CRASH} s, before the array returned`,
              (s, ctx) =>
                vms(s).every((v) => {
                  const e = eventsMatching(ctx, 'vm.crashed', { device: v.id })[0];
                  return e !== undefined && e.t >= T0 + CRASH && e.t < RESTORE_AT;
                }),
            ),
            at(RESTORE_AT, 'crashed VMs stay down while the array is gone', (s) =>
              vms(s).every((v) => v.host === null),
            ),
            atCtx(END, 'AHV HA restarts them only after the array is back', (_s, ctx) => {
              const first = firstEventAt(ctx, 'ha.vm.restarted');
              return (
                first !== null &&
                first > RESTORE_AT &&
                vms(_s).every((v) => eventSeen(ctx, 'ha.vm.restarted', { device: v.id }))
              );
            }),
          ]
        : [
            alwaysFrom(T0 + 1, 'no VM crashes: they keep retrying', (s) =>
              vms(s).every((v) => v.host !== null),
            ),
            at(RESTORE_AT, 'VMs are still stalled in place', (s) =>
              allVms(s, (v) => isStalled(v) && v.host === v.id.split('.')[0]),
            ),
            neverSeen(END, 'vm.crashed'),
            neverSeen(END, 'ha.vm.restarted'),
          ]),
      allRunningAt(END),
      ...baseInvariants(),
    ],
    narrative: crash
      ? `The whole FlashArray is gone for ${RESTORE_AT - T0} s. Every node tries to enter Hades maintenance mode but the cluster admits only N−2, cluster services stop and VM IO stalls everywhere. A guest cannot wait forever: after ${CRASH} s of stalled IO each VM crashes (QEMU exits, "VM shut down unexpectedly"), and nothing restarts it until the array is back, the cluster services re-form and AHV HA restarts the VMs on hosts that reach the array.`
      : `The same ${RESTORE_AT - T0} s whole-array loss with whole-array-loss-vm-behavior set to stall. VM IO retries until the array responds, as the deployment guide words it, so the VMs stay stalled in place for the whole outage and resume on their own hosts once paths and services return.`,
    cite: ['ntnx-ncp-everpure-deploy-7.6', 'ntnx-bible-5b', 'ntnx-cmdref-aos-7.6'],
    status: 'active',
  });
}

export default [variant('crash-and-restart'), variant('stall')];
