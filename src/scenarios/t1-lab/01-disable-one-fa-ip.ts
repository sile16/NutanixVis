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
import { KATO, P, PATH_LOSS_WORST } from '../timers';

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
    at(by(KATO), 'every CVM loses exactly the path to that IP', (s) =>
      allCvms(s, (c) => onlyPathsLostTo(c, [IP])),
    ),
    alwaysFrom(T0, 'VMs keep running (latency outliers only)', (s) => allVms(s, isRunning)),
    alwaysFrom(T0, 'no command waits longer than KATO + CQT', (s) =>
      allVms(s, (v) => v.ioPendingS <= PATH_LOSS_WORST + SLACK),
    ),
    at(END, 'the path reconnects once the IP is back', (s) => allCvms(s, allPathsLive)),
    ...baseInvariants(),
  ],
  narrative:
    "One of the array's data IPs is disabled. Every CVM's path to that IP goes silent and is declared lost after the keep-alive timeout, while IO carries on over the other paths, which are all ANA Optimized. When the IP comes back, the next reconnect attempt restores the path.",
  cite: ['nvme-base-spec', 'everpure-ana-faq', 'everpure-ha-scenarios'],
  status: 'todo',
});
