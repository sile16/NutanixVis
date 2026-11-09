import { defineScenario } from '../define';
import {
  alwaysFrom,
  atCtx,
  baseInvariants,
  device,
  eventSeen,
  isRunning,
  neverSeen,
  T0,
  t1Steady,
  vm,
  vms,
  vswitch,
} from '../helpers';
import { cvmId, nodeId, T1, vmId } from '../ids';
import { stepOfStage, stepsOf } from '../steps';

const VM = vmId(1, 1);
const CVM = cvmId(1);
const END = T0 + 120;

/**
 * A hung LACP member that keeps exchanging LACPDUs (a data-plane hang): LACP never detaches it.
 * Owner lab result (2026-11-07): the whole CVM fails, on the same timeline as losing both storage
 * NICs (T1-32), because a flow dies if either direction hashes onto the hung link (the host's
 * bond hash out, the switch side's local member back) and the kernel's own connections die too.
 */
export default defineScenario({
  id: 't1-36-hung-lacp-member-lacpdus-flowing',
  title: 'T1: a hung LACP member that keeps sending LACPDUs (never detected)',
  topology: T1.topology,
  options: {
    'node-count': 3,
    'vm-layout': 'two',
    'vs1-bond-mode': 'balance-tcp',
    'storage-vlans': 'single',
  },
  durationS: END,
  timeline: [
    {
      at: T0,
      action: { kind: 'hang', target: T1.storageNicA(1), params: { lacpdus: 'keep flowing' } },
      note: 'Node 1 eth2 hangs: carrier stays up and LACPDUs keep flowing, data frames die.',
    },
  ],
  expect: [
    ...t1Steady(),
    neverSeen(END, 'net.bond.lacp-timeout'),
    alwaysFrom(
      T0,
      'LACP never detaches the hung member',
      (s) => vswitch(s, T1.storageVs(1)).activeMembers === 2,
    ),
    atCtx(
      END,
      "the VM's IO stalls completely, not only the flows hashed onto the member",
      (_s, ctx) => stepsOf(ctx, VM).peakStuckPct === 100,
    ),
    atCtx(
      END,
      'node 1 goes into maintenance on the same step as losing both storage NICs',
      (_s, ctx) => {
        const st = stepsOf(ctx, VM);
        return stepOfStage(st, 'maintenance') === 4 && stepOfStage(st, 'redirected') === 4;
      },
    ),
    atCtx(END, 'then IO resumes through another CVM', (_s, ctx) => {
      const st = stepsOf(ctx, VM);
      return st.resumeStep === 4 && st.impact === 'redirected';
    }),
    atCtx(
      END,
      'the other nodes are unaffected',
      (_s, ctx) =>
        !ctx.events.some((e) => e.code === 'hades.maintenance.enter' && e.deviceId !== CVM) &&
        eventSeen(ctx, 'hades.maintenance.enter'),
    ),
    atCtx(END, 'the VM runs on a remote CVM at the end', (s) => {
      const v = vm(s, VM);
      return isRunning(v) && v.ownerCvm !== CVM;
    }),
    alwaysFrom(T0, 'VMs of the other nodes never stall', (s) =>
      vms(s)
        .filter((v) => !v.id.startsWith(`${nodeId(1)}.`))
        .every(isRunning),
    ),
    atCtx(
      END,
      'Hades acted on the stuck IO, not on a lost CVM',
      (s) => device(s, CVM).fields.state === 'up',
    ),
    ...baseInvariants(),
  ],
  narrative:
    "Node 1's eth2 hangs without losing carrier, and it keeps exchanging LACPDUs, so LACP never detaches it and nothing reports a problem. A flow dies if either direction hashes onto the hung link, so the VM's IO stalls completely and the CVM's own service-volume connections die too. Hades puts the node in maintenance on the same step as losing both storage NICs, and the VM's IO resumes through another CVM. Only repairing or disabling the port ends it.",
  cite: ['ovs-bonding', 'ntnx-ahv-admin-11.2', 'ntnx-cmdref-aos-7.6', 'nvme-base-spec'],
  status: 'active',
});
