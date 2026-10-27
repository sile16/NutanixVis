import { defineScenario, type ScenarioDef, type ScenarioStep } from '../define';
import {
  allRunningAt,
  allVms,
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  by,
  derived,
  disk,
  eventSeen,
  isRunning,
  neverSeen,
  T0,
  wasEver,
} from '../helpers';
import { diskId, T2 } from '../ids';
import { P } from '../timers';

const DISK = diskId(1, 3);
const LIMIT = P.hci.diskOfflineEventsPerHourToStayOffline;

function hardFailure(): ScenarioDef {
  const END = T0 + 1200;
  return defineScenario({
    id: 't2-07-disk-failure',
    title: 'T2: a single disk fails',
    topology: T2.topology,
    durationS: END,
    timeline: [
      { at: T0, action: { kind: 'disk.fail', target: DISK }, note: 'An SSD on node 1 fails.' },
    ],
    expect: [
      allRunningAt(T0, 'steady state: all VMs running'),
      atCtx(
        by(0),
        'Stargate marks the disk offline',
        (s, ctx) =>
          disk(s, DISK).state !== 'online' && eventSeen(ctx, 'disk.offline', { device: DISK }),
      ),
      atCtx(by(P.hci.rebuildStartDelayS), 'rebuild starts immediately', (_s, ctx) =>
        eventSeen(ctx, 'curator.rebuild.start'),
      ),
      alwaysFrom(T0, 'VM IO continues, re-read from replicas', (s) => allVms(s, isRunning)),
      alwaysFrom(T0, 'storage stays available', (s) => derived(s).dataAvailable),
      atCtx(END, 'resiliency showed Rebuilding', (_s, ctx) =>
        wasEver(ctx, (s) => derived(s).resiliency === 'Rebuilding', T0),
      ),
      at(END, 'the failed disk stays out of service', (s) => disk(s, DISK).state !== 'online'),
      at(END, 'rebuild has restored full redundancy', (s) => derived(s).resiliency === 'OK'),
      neverSeen(END, 'redirector.redirect'),
      neverSeen(END, 'ha.host.disconnected'),
      ...baseInvariants(),
    ],
    narrative:
      "One SSD on node 1 fails. Stargate takes it offline and reads are served from the other replicas, so VMs see no IO errors and there is no HA event. Curator starts re-replicating the disk's data immediately.",
    cite: ['ntnx-bible-4i', 'ntnx-bible-4g'],
    status: 'active',
  });
}

/** Offline/recover cycles a minute apart: 3 offline events inside an hour keep the disk out. */
function flapping(): ScenarioDef {
  const cycle = 60;
  const steps: ScenarioStep[] = [];
  for (let i = 0; i < LIMIT; i++) {
    steps.push({ at: T0 + i * 2 * cycle, action: { kind: 'disk.fail', target: DISK } });
    steps.push({ at: T0 + i * 2 * cycle + cycle, action: { kind: 'recover', target: DISK } });
  }
  const lastRecover = T0 + (LIMIT - 1) * 2 * cycle + cycle;
  const END = lastRecover + 300;
  return defineScenario({
    id: 't2-07-disk-flapping',
    title: `T2: a disk goes offline ${LIMIT} times within an hour`,
    topology: T2.topology,
    durationS: END,
    timeline: steps,
    expect: [
      allRunningAt(T0, 'steady state: all VMs running'),
      at(
        T0 + 2 * cycle - 1,
        'after one blip the disk passes its SMART check and returns',
        (s) => disk(s, DISK).state === 'online',
      ),
      at(
        END,
        `after ${LIMIT} offline events in an hour the disk stays offline`,
        (s) => disk(s, DISK).state !== 'online' && disk(s, DISK).offlineEventsLastHour >= LIMIT,
      ),
      alwaysFrom(T0, 'VM IO continues throughout', (s) => allVms(s, isRunning)),
      ...baseInvariants(),
    ],
    narrative:
      'A disk keeps dropping offline and coming back. Each time, Hades runs a SMART check and returns it to service if it passes, but a disk that goes offline three times within an hour stays offline. VM IO is served from replicas throughout.',
    cite: ['ntnx-bible-4i'],
    status: 'active',
  });
}

export default [hardFailure(), flapping()];
