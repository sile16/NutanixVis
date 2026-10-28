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
import { CLOSED_PATH_WORST } from '../timers';

const END = by(CLOSED_PATH_WORST) + 30;

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
    // Disabled IPs refuse the connection: the paths are lost on the next frame, not after KATO.
    at(by(0), 'every CVM loses all its VLAN-10 paths at once and keeps VLAN 20', (s) =>
      allCvms(s, (c) => onlyPathsLostTo(c, T1_LAB.faIfacesVlan10)),
    ),
    alwaysFrom(T0, 'VMs keep running on VLAN 20', (s) => allVms(s, isRunning)),
    alwaysFrom(T0, 'no command waits longer than CQT (closed connection)', (s) =>
      allVms(s, (v) => v.ioPendingS <= CLOSED_PATH_WORST + SLACK),
    ),
    ...baseInvariants(),
  ],
  narrative:
    "Every array IP on storage VLAN 10 is disabled, on both controllers. The array refuses connections to them, so each CVM's VLAN-10 vNIC loses all of its paths at once, and the VLAN-20 paths carry all the IO; commands that were in flight on VLAN 10 are retried after the quiesce time (CQT). This is why at least two storage VLANs are recommended.",
  cite: ['everpure-nutanix-net-bp', 'nvme-base-spec-2.1', 'everpure-ana-faq'],
  // todo until the workload issues at least one IO per NVMe path per tick (src/domain/workload/io.ts:
  // 2 reads + 2 writes, queue depth 32): with 1 + 1 a tick's two IOs can both land on the
  // silently lost paths, so the VM reads io-stalled for that tick although IO is flowing.
  status: 'active',
});
