import { defineScenario } from '../define';
import {
  allCvms,
  allPathsLive,
  allVms,
  alwaysFrom,
  at,
  baseInvariants,
  by,
  isRunning,
  onlyPathsLostTo,
  SLACK,
  T0,
  t1Steady,
} from '../helpers';
import { T1_LAB } from '../ids';
import { CLOSED_PATH_WORST, P } from '../timers';

const IP = 'fa.ct0.eth10.v10';
const ENABLE_AT = T0 + 120;
const END = by(P.externalStorage.reconnectDelayS, ENABLE_AT) + 10;

export default defineScenario({
  id: 't1lab-01-disable-one-fa-ip',
  title: 'T1-lab: disable one FlashArray data IP',
  topology: T1_LAB.topology,
  durationS: END,
  timeline: [
    {
      at: T0,
      action: { kind: 'fa.interface.disable', target: IP },
      note: 'Disable ct0.eth10 VLAN 10.',
    },
    { at: ENABLE_AT, action: { kind: 'fa.interface.enable', target: IP }, note: 'Re-enable it.' },
  ],
  expect: [
    ...t1Steady(),
    // A disabled IP refuses the connection: the path is lost on the next frame, not after KATO.
    at(by(0), 'every CVM loses exactly the path to that IP, at once', (s) =>
      allCvms(s, (c) => onlyPathsLostTo(c, [IP])),
    ),
    alwaysFrom(T0, 'VMs keep running (latency outliers only)', (s) => allVms(s, isRunning)),
    alwaysFrom(T0, 'no command waits longer than CQT (closed connection)', (s) =>
      allVms(s, (v) => v.ioPendingS <= CLOSED_PATH_WORST + SLACK),
    ),
    at(END, 'the path reconnects once the IP is back', (s) => allCvms(s, allPathsLive)),
    ...baseInvariants(),
  ],
  narrative:
    "One of the array's data IPs is disabled. The array refuses connections to it, so every CVM loses its path to that IP at once, without waiting for the keep-alive timeout. New IO carries on over the other paths, which are all ANA Optimized; the commands that were in flight on the lost path are retried after the quiesce time (CQT). When the IP comes back, the next reconnect attempt restores the path.",
  cite: ['nvme-base-spec-2.1', 'everpure-ana-faq', 'everpure-nutanix-nci-cfg'],
  status: 'active',
});
