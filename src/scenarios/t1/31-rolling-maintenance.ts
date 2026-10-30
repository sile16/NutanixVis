import { defineScenario, type ScenarioDef } from '../define';
import {
  allRunningAt,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  by,
  eventSeen,
  eventsInOrder,
  isRunning,
  neverSeen,
  SLACK,
  T0,
  t1Steady,
  vmsOfNode,
  wasEver,
} from '../helpers';
import { cvmId, nodeId, T1 } from '../ids';
import { P, RESET_PAUSE, SILENT_PAUSE_MIN } from '../timers';

/** Node 2: not the Acropolis leader's node. */
const NODE = 2;
const CVM = cvmId(NODE);
const HOST = nodeId(NODE);
const PREP = P.cluster.plannedShutdownPrepS;
const MIG = P.ahvHa.liveMigrationPauseS;
const RET = P.ahvHa.maintenanceReturnS;
const BOOT = P.cluster.cvmBootS;
/** Brief blips only: a migration switchover or a re-login. */
const BLIP = Math.max(MIG, RESET_PAUSE) + SLACK;

type Mode = 'rolling' | 'planned' | 'abrupt';

/**
 * Planned maintenance, the upgrade / LCM path (SPEC §6.2 "Planned maintenance"; AHV Admin Guide
 * 11.2 "Shutting Down a Node"):
 * - `rolling`: node 2's host enters maintenance mode (its VMs live-migrate off, brief pause each),
 *   its CVM is shut down in a planned way (no VM is left on the host), started again, and the host
 *   exits maintenance; Acropolis migrates the VMs back after `ahvHa.maintenanceReturnS`.
 * - `planned`: a planned CVM shutdown with the VMs left on the host: the shutdown token, traffic
 *   forwarding and an orderly service stop release the vDisks first, so the VMs' IO moves to peers
 *   after a brief re-login and the VMs stay on their host.
 * - `abrupt`: the same CVM rebooted abruptly, for contrast: its vDisk leadership is held until its
 *   Zookeeper session expires, so the VMs stall far longer.
 */
function variant(mode: Mode): ScenarioDef {
  const start = T0 + 30;
  const exit = start + BOOT + 30;
  const END = mode === 'rolling' ? exit + RET + 30 : T0 + 60;
  const timeline =
    mode === 'rolling'
      ? [
          {
            at: T0,
            action: { kind: 'host.enter-maintenance', target: HOST },
            note: "Node 2's host enters maintenance mode: its VMs live-migrate to other hosts.",
          },
          {
            at: T0 + 10,
            action: { kind: 'cvm.planned-shutdown', target: CVM },
            note: 'CVM 2 is shut down in a planned way (the upgrade path).',
          },
          {
            at: start,
            action: { kind: 'cvm.planned-start', target: CVM },
            note: 'CVM 2 is started again (after its upgrade).',
          },
          {
            at: exit,
            action: { kind: 'host.exit-maintenance', target: HOST },
            note: "Node 2's host exits maintenance mode.",
          },
        ]
      : [
          {
            at: T0,
            action: {
              kind: mode === 'planned' ? 'cvm.planned-shutdown' : 'reboot',
              target: CVM,
            },
            note:
              mode === 'planned'
                ? 'CVM 2 is shut down in a planned way, with its VMs left on node 2.'
                : 'CVM 2 is rebooted abruptly, with its VMs on node 2.',
          },
        ];
  const expect =
    mode === 'rolling'
      ? [
          alwaysFrom(T0, 'node 2 VM IO pauses stay brief (migration switchovers, re-logins)', (s) =>
            vmsOfNode(s, NODE).every((v) => v.ioPendingS <= BLIP),
          ),
          at(by(MIG), "node 2's VMs run on other hosts", (s) =>
            vmsOfNode(s, NODE).every((v) => isRunning(v) && v.host !== HOST),
          ),
          atCtx(by(MIG), 'they were live-migrated, not restarted', (_s, ctx) =>
            eventSeen(ctx, 'vm.migrated'),
          ),
          atCtx(T0 + 10 + PREP + SLACK, 'CVM 2 powers off after its planned shutdown', (_s, ctx) =>
            eventSeen(ctx, 'cvm.planned-shutdown.off', { device: CVM }),
          ),
          at(exit - 1, 'no VM was placed back on the host while it was in maintenance', (s) =>
            vmsOfNode(s, NODE).every((v) => v.host !== HOST),
          ),
          at(END, "node 2's VMs are back on node 2", (s) =>
            vmsOfNode(s, NODE).every((v) => isRunning(v) && v.host === HOST),
          ),
          atCtx(END, 'order: maintenance, migrate off, planned shutdown, exit, return', (_s, ctx) =>
            eventsInOrder(ctx, [
              { code: 'host.maintenance.enter', device: HOST },
              { code: 'vm.migrated' },
              { code: 'cvm.planned-shutdown.off', device: CVM },
              { code: 'host.maintenance.exit', device: HOST },
              { code: 'vm.migrated' },
            ]),
          ),
          allRunningAt(END),
        ]
      : mode === 'planned'
        ? [
            alwaysFrom(T0, 'node 2 VM IO pause stays a brief re-login', (s) =>
              vmsOfNode(s, NODE).every((v) => v.ioPendingS <= BLIP),
            ),
            at(T0 + PREP + BLIP + SLACK, 'node 2 VMs run on peer Stargates, still on node 2', (s) =>
              vmsOfNode(s, NODE).every(
                (v) => isRunning(v) && v.host === HOST && v.ownerCvm !== CVM,
              ),
            ),
            neverSeen(END, 'redirector.parked'),
          ]
        : [
            atCtx(
              END,
              'node 2 VMs stall far longer than a re-login (leadership held until ZK expiry)',
              (_s, ctx) =>
                wasEver(
                  ctx,
                  (s) => vmsOfNode(s, NODE).some((v) => v.ioPendingS >= SILENT_PAUSE_MIN),
                  T0,
                  END,
                ),
            ),
          ];
  return defineScenario({
    id: `t1-31-maintenance-${mode}`,
    title:
      mode === 'rolling'
        ? 'T1: rolling maintenance — host maintenance mode, planned CVM shutdown, return'
        : mode === 'planned'
          ? 'T1: planned CVM shutdown — IO moves with only a brief re-login'
          : 'T1: abrupt CVM reboot — the contrast to a planned shutdown',
    topology: T1.topology,
    durationS: END,
    timeline,
    expect: [
      ...t1Steady(),
      ...expect,
      neverSeen(END, 'ha.vm.restarted'),
      neverSeen(END, 'vm.crashed'),
      ...baseInvariants(),
    ],
    narrative:
      mode === 'rolling'
        ? `Node 2's host enters maintenance mode: it takes no new VMs and its VMs live-migrate to other hosts, each pausing about ${MIG} s at the switchover while its disks log in to the destination's local Stargate. CVM 2 is then shut down in a planned way and started again, as during an upgrade; no VM is left on its host. When the host exits maintenance, Acropolis migrates the VMs back after about ${RET} s.`
        : mode === 'planned'
          ? "CVM 2 is shut down in a planned way with its VMs still on node 2. The cluster grants the shutdown token, forwards traffic away and stops CVM 2's services in an orderly way, so its Stargate releases its vDisks first: the VMs' sessions log in to peer Stargates through the host's redirector and IO resumes after a brief re-login. The VMs stay on node 2."
          : "CVM 2 is rebooted abruptly with its VMs on node 2. Its connections reset, but its vDisk leadership is held until its Zookeeper session expires, so the VMs' first logins to peers park and IO resumes only at the next NOP cycle after the expiry: a far longer pause than a planned shutdown.",
    cite: ['ntnx-ahv-admin-11.2', 'ntnx-bible-5b'],
    status: 'active',
  });
}

export default [variant('rolling'), variant('planned'), variant('abrupt')];
