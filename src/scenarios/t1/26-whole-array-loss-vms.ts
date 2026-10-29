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
import { HADES_DETECT, HADES_RECOVER, P } from '../timers';

const RESTORE_AT = T0 + 300;
const CRASH = P.redirector.initiatorSessionTimeoutS;
const END = by(HADES_RECOVER + P.ahvHa.restartByS, RESTORE_AT) + 30;

/**
 * Whole-array loss for minutes (SPEC §6.4 "T1 full array loss", §14). Every CVM loses every path
 * and its service volumes, so every node enters Hades maintenance mode and its Stargate stops:
 * no Stargate is left to serve, and VM IO stalls everywhere.
 * - `crash-and-restart` (default, `assumption`): once no Stargate has served a VM for the
 *   initiator session timeout (`redirector.initiatorSessionTimeoutS`), the initiator gives up and
 *   the VM crashes (QEMU exits, "VM shut down unexpectedly"). Nothing restarts it while the array
 *   is gone (no cluster services, no Acropolis leader); after the array returns and the services
 *   re-form, AHV powers the VMs back on on hosts whose CVM reaches the array.
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
      atCtx(by(HADES_DETECT), 'every node enters Hades maintenance mode', (s, ctx) =>
        cvms(s).every((c) => eventSeen(ctx, 'hades.maintenance.enter', { device: c.id })),
      ),
      at(T0 + CRASH - 5, 'VM IO is stalled everywhere', (s) => allVms(s, isStalled)),
      ...(crash
        ? [
            atCtx(
              RESTORE_AT,
              `every VM crashed once no Stargate had served it for ${CRASH} s, before the array returned`,
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
      ? `The whole FlashArray is gone for ${RESTORE_AT - T0} s. Every node enters Hades maintenance mode, so its services stop and no Stargate is left to serve; VM IO stalls everywhere. Once no Stargate has served a VM for ${CRASH} s, its iSCSI initiator gives up and the VM crashes (QEMU exits, "VM shut down unexpectedly"). Nothing restarts it until the array is back, the cluster services re-form and AHV powers the VMs back on on hosts that reach the array.`
      : `The same ${RESTORE_AT - T0} s whole-array loss with whole-array-loss-vm-behavior set to stall. VM IO retries until the array responds, as the deployment guide words it, so the VMs stay stalled in place for the whole outage and resume on their own hosts once paths and services return.`,
    cite: ['ntnx-ncp-everpure-deploy-7.6', 'ntnx-bible-5b', 'ntnx-cmdref-aos-7.6'],
    status: 'active',
  });
}

export default [variant('crash-and-restart'), variant('stall')];
