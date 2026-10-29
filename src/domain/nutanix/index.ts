/**
 * Stream F: Nutanix cluster services, AHV HA and the VM workload (SPEC §6.1–6.3a, §13.2).
 *
 * `createNutanixDomain` builds, from the declarative topology and the active profile:
 * - one `ahv-host` device per host (power, HA state, iSCSI redirector),
 * - one `cvm` device per CVM, delegating to its storage backend (`backendFor`), Stargate,
 *   Zookeeper member, Cassandra node and Acropolis worker,
 * - one `vm` device per VM (IO generator + lifecycle),
 * - the `cluster` device (ZK quorum, Cassandra ring, Acropolis leader, AHV HA, derived status),
 * and returns the `ClusterView` handed to every backend's `attach`.
 */
import type { NutanixDomain } from '../contracts';
import { cited } from '../versions/cited';
import { WORKLOAD } from '../workload/io';
import { Vm } from '../workload/vm';
import { nutanixActions } from './actions';
import { ClusterDevice } from './cluster';
import { Cvm } from './cvm';
import { buildFacts } from './facts';
import { AhvHost } from './host';
import { TRAFFIC } from './messages';
import { Registry } from './registry';

export { CLUSTER_DEVICE_ID } from './cluster';
export { buildFacts, type Facts, vdiskId } from './facts';
export { MSG, TRAFFIC } from './messages';
export type { NutanixClusterView } from './registry';

export const createNutanixDomain: NutanixDomain = ({ topology, profile, backendFor }) => {
  const facts = buildFacts(topology);
  const reg = new Registry(facts, profile, backendFor);
  const hosts = facts.hosts.map((h) => new AhvHost(h, reg));
  for (const h of hosts) reg.hosts.set(h.id, h);
  const cvms = facts.cvms.map((c) => {
    const backend = reg.backends.get(c.id);
    if (!backend) throw new Error(`no storage backend for ${c.id}`);
    return new Cvm(c, backend, reg);
  });
  for (const c of cvms) reg.cvms.set(c.id, c);
  // `guest-queue-depth` (T1): a queue-depth-bound guest with fewer slots (SPEC §6.4c).
  const workload =
    facts.guestQueueDepth === null
      ? WORKLOAD
      : {
          ...WORKLOAD,
          queueDepth: cited(
            facts.guestQueueDepth,
            'assumption',
            [],
            'Topology option guest-queue-depth (illustrative guest queue depth per vDisk).',
          ),
        };
  const vms = facts.vms.map((v) => new Vm(v, reg, workload));
  for (const v of vms) reg.vms.set(v.id, v);
  const cluster = new ClusterDevice(reg);
  // Contract: `attach` once after all devices exist (a backend shared by CVMs is attached once).
  for (const b of new Set(reg.backends.values())) b.attach(reg);
  return {
    devices: [cluster, ...hosts, ...cvms, ...vms],
    actions: nutanixActions(reg),
    traffic: TRAFFIC,
    cluster: reg,
  };
};
