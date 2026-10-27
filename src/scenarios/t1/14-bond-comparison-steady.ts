import type { Snapshot } from '../../engine/types';
import { defineScenario, type ScenarioDef } from '../define';
import { allRunningAt, at, baseInvariants, cvm, T0, t1Steady, vm, vswitch } from '../helpers';
import { T1, vmId } from '../ids';

type Mode = 'active-backup' | 'balance-slb' | 'balance-tcp';
type Policy = 'active-active' | 'active-passive';

const VM = vmId(1, 1);
const CHECK = T0 + 10;

/** Expected uplink use for one vDisk (SPEC §6.4b "Can one vDisk use both uplinks?"). */
function pathUsage(mode: Mode, policy: Policy): { label: string; that: (s: Snapshot) => boolean } {
  const view = (s: Snapshot) => vm(s, VM);
  if (mode === 'active-backup') {
    return {
      label: 'every path rides the single active uplink',
      that: (s) => {
        const vs = vswitch(s, T1.storageVs(1));
        return (
          vs.activeMembers === 1 &&
          view(s).ioUplinks.length === 1 &&
          view(s).ioUplinks[0] === vs.activeMember
        );
      },
    };
  }
  if (policy === 'active-passive') {
    return mode === 'balance-slb'
      ? {
          label: 'one active path, pinned to one uplink',
          that: (s) => view(s).ioPaths.length === 1 && view(s).ioUplinks.length === 1,
        }
      : {
          label: "one active path; its queues' TCP connections may hash to both uplinks",
          that: (s) => view(s).ioPaths.length === 1 && view(s).ioUplinks.length >= 1,
        };
  }
  return mode === 'balance-slb'
    ? {
        label:
          'IO uses every live path, split by vNIC: uplinks are exactly the vNICs’ pinned members',
        that: (s) => {
          const pinning = vswitch(s, T1.storageVs(1)).pinning;
          const pinned = new Set([pinning[T1.segA(1)], pinning[T1.segB(1)]]);
          const used = new Set(view(s).ioUplinks);
          return (
            view(s).ioPaths.length === cvm(s, 1).nvmePathsUp &&
            used.size === pinned.size &&
            [...used].every((u) => pinned.has(u))
          );
        },
      }
    : {
        label: "IO uses every live path and the paths' connections hash across both uplinks",
        that: (s) =>
          view(s).ioPaths.length === cvm(s, 1).nvmePathsUp && view(s).ioUplinks.length === 2,
      };
}

function variant(mode: Mode, policy: Policy): ScenarioDef {
  const usage = pathUsage(mode, policy);
  return defineScenario({
    id: `t1-14-bond-steady-${mode}-${policy}`,
    title: `T1 bond comparison (steady): ${mode}, multipath ${policy}`,
    topology: T1.topology,
    // Both storage VLANs on both switches: under isolated A/B VLANs only correctly pinned MAC
    // pinning carries both VLANs, so the comparison is made on the trunked fabric.
    options: {
      'vlan-placement': 'tagged-both',
      // The bond can only save a path if the ISL carries the storage VLANs.
      'isl-storage-vlans': 'allowed',
      'vs1-bond-mode': mode,
      'multipath-policy': policy,
      ...(mode === 'balance-tcp' ? { mlag: true } : {}),
    },
    durationS: CHECK + 10,
    timeline: [],
    expect: [
      ...t1Steady(),
      at(T0, `vs1 runs ${mode}`, (s) =>
        T1.nodes.every((n) => vswitch(s, T1.storageVs(n)).bondMode === mode),
      ),
      ...(mode === 'balance-tcp'
        ? [
            at(
              T0,
              'LACP negotiated across the MLAG pair',
              (s) => vswitch(s, T1.storageVs(1)).lacpState === 'negotiated',
            ),
          ]
        : []),
      at(CHECK, usage.label, usage.that),
      allRunningAt(CHECK),
      ...baseInvariants(),
    ],
    narrative:
      'With both storage VLANs on both switches, a vDisk is served by one CVM, so its IO only ever leaves through that node’s vs1 uplinks. ' +
      (mode === 'active-backup'
        ? 'Active-Backup puts every path on the single active uplink.'
        : mode === 'balance-slb'
          ? 'MAC pinning places each storage vNIC on one uplink, so a vDisk can use both uplinks only through different vNICs, and only if their hashes land on different members.'
          : 'LACP hashes each TCP connection, so the admin and IO queues of each path spread across both uplinks.') +
      (policy === 'active-active'
        ? ' With active-active multipath the vDisk round-robins across every live path.'
        : ' With active-passive multipath the vDisk uses one path at a time.') +
      ' The multipath policy is an assumption until it can be measured.',
    cite: ['ntnx-ahv-admin-11.2', 'everpure-nutanix-net-bp', 'ntnx-bible-8c', 'everpure-ana-faq'],
    // Active-active variants: todo until the workload issues at least one IO per path per tick
    // (src/domain/workload/io.ts: 2 reads + 2 writes); with 1 + 1 one tick touches only 2 of
    // the 4 paths, so 'IO uses every live path' cannot hold.
    status: policy === 'active-passive' || mode === 'active-backup' ? 'active' : 'todo',
  });
}

const MODES: readonly Mode[] = ['active-backup', 'balance-slb', 'balance-tcp'];
const POLICIES: readonly Policy[] = ['active-active', 'active-passive'];

export default MODES.flatMap((m) => POLICIES.map((p) => variant(m, p)));
