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
import { Vm } from '../workload/vm';
import { nutanixActions } from './actions';
import { NUTANIX_ASSUMPTIONS } from './assumptions';
import { ClusterDevice } from './cluster';
import { Cvm } from './cvm';
import { buildFacts } from './facts';
import { AhvHost } from './host';
import { TRAFFIC } from './messages';
import { Registry } from './registry';

export { NUTANIX_ASSUMPTIONS, type NutanixAssumptions } from './assumptions';
export { CLUSTER_DEVICE_ID } from './cluster';
export { buildFacts, type Facts, vdiskId } from './facts';
export { MSG, TRAFFIC } from './messages';
export type { NutanixClusterView } from './registry';

export const createNutanixDomain: NutanixDomain = ({ topology, profile, backendFor }) => {
  const facts = buildFacts(topology);
  const reg = new Registry(facts, profile, NUTANIX_ASSUMPTIONS, backendFor);
  const hosts = facts.hosts.map((h) => new AhvHost(h, reg));
  for (const h of hosts) reg.hosts.set(h.id, h);
  const cvms = facts.cvms.map((c) => {
    const backend = reg.backends.get(c.id);
    if (!backend) throw new Error(`no storage backend for ${c.id}`);
    return new Cvm(c, backend, reg);
  });
  for (const c of cvms) reg.cvms.set(c.id, c);
  const vms = facts.vms.map((v) => new Vm(v, reg));
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
