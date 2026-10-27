import { defineScenario } from '../define';
import {
  allCvms,
  allVms,
  alwaysFrom,
  at,
  baseInvariants,
  by,
  faDataInterfaces,
  isRunning,
  onlyPathsLostTo,
  SLACK,
  T0,
  t1Steady,
} from '../helpers';
import { T1_LAB } from '../ids';
import { KATO, PATH_LOSS_WORST } from '../timers';

const END = by(PATH_LOSS_WORST) + 30;

export default defineScenario({
  id: 't1lab-02-disable-vlan-10-ips',
  title: 'T1-lab: disable every FlashArray IP on storage VLAN 10',
  topology: T1_LAB.topology,
  durationS: END,
  timeline: T1_LAB.faIfacesVlan10.map((target) => ({
    at: T0,
    action: { kind: 'fa.interface.disable', target },
  })),
  expect: [
    ...t1Steady(),
    at(T0 + 2, 'every VLAN-10 data IP on the array is disabled', (s) =>
      faDataInterfaces(s)
        .filter((i) => i.vlan === 10)
        .every((i) => !i.enabled),
    ),
    at(by(KATO), 'every CVM loses all its VLAN-10 paths and keeps VLAN 20', (s) =>
      allCvms(s, (c) => onlyPathsLostTo(c, T1_LAB.faIfacesVlan10)),
    ),
    alwaysFrom(T0, 'VMs keep running on VLAN 20', (s) => allVms(s, isRunning)),
    alwaysFrom(T0, 'no command waits longer than KATO + CQT', (s) =>
      allVms(s, (v) => v.ioPendingS <= PATH_LOSS_WORST + SLACK),
    ),
    ...baseInvariants(),
  ],
  narrative:
    "Every array IP on storage VLAN 10 is disabled, on both controllers. Each CVM's VLAN-10 vNIC loses all of its paths after the keep-alive timeout, while the VLAN-20 paths carry all the IO. This is why at least two storage VLANs are recommended.",
  cite: ['everpure-nutanix-net-bp', 'nvme-base-spec', 'everpure-ana-faq'],
  status: 'todo',
});
