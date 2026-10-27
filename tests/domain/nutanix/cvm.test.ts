/**
 * CVM device: component delegation, boot lifecycle (`cluster.cvmBootS`), Stargate ownership via
 * `backend.acquire` / `release`, fencing and quorum rules, and the `ClusterView` given to E/G.
 */
import { describe, expect, it } from 'vitest';
import { current as P } from '../../../src/domain/versions/profiles/current';
import { harness, vmState } from './harness';

const BOOT = P.cluster.cvmBootS.value;
const T = 11;

function backend(h: ReturnType<typeof harness>, cvm: string) {
  const b = h.backends.get(cvm);
  if (!b) throw new Error(`no backend ${cvm}`);
  return b;
}

describe('delegation to the storage backend', () => {
  it('attaches every backend once with the ClusterView, then delegates every hook each tick', () => {
    const h = harness('t2-hci-ahv');
    const b = backend(h, 'node-1.cvm');
    expect(b.attachCount).toBe(1);
    expect(b.cluster).toBe(h.cluster);
    h.run(5);
    expect(b.calls).toMatchObject({ preTick: 5, emit: 5, tick: 5, postTick: 5 });
  });

  it('merges backend view fields and derived keys; HCI backend facts map onto derived', () => {
    const t1 = harness('t1-ahv-flasharray');
    t1.run(1);
    expect(t1.f('node-1.cvm', 'nvmePathsUp')).toBe(1);
    const t2 = harness('t2-hci-ahv');
    t2.run(1);
    expect(t2.f('node-1.cvm', 'nvmePathsUp')).toBeNull();
    for (const b of t2.backends.values()) {
      b.extraDerived = {
        'hci.dataNodeFailureTolerance': 0,
        'hci.rf': 3,
        resiliency: 'Rebuilding',
      };
    }
    t2.run(1);
    expect(t2.d('nodeFailureTolerance')).toBe(0);
    expect(t2.d('ftConfigured')).toBe(2);
    expect(t2.d('resiliency')).toBe('Rebuilding');
  });

  it('a failed CVM fails its components; they recover only when the boot completes', () => {
    const h = harness('t2-hci-ahv');
    const b = backend(h, 'node-2.cvm');
    h.run(10);
    h.act('fail', 'node-2.cvm');
    h.run(5);
    expect(b.calls.onFail).toBe(1);
    h.act('recover', 'node-2.cvm');
    const ticksBefore = b.calls.tick;
    // Recover applies at t=16; the boot completes at 16 + cvmBootS.
    h.run(BOOT);
    expect(b.calls.onRecover).toBe(0);
    expect(b.calls.tick).toBe(ticksBefore);
    expect(h.f('node-2.cvm', 'state')).toBe('up');
    expect(h.f('node-2.cvm', 'stargate')).toBe('down');
    expect(h.cluster.isCvmUp('node-2.cvm')).toBe(false);
    h.run(1);
    expect(b.calls.onRecover).toBe(1);
    expect(h.f('node-2.cvm', 'stargate')).toBe('up');
    expect(h.firstAt('stargate.up', 'node-2.cvm')).toBe(16 + BOOT);
    expect(h.cluster.isStargateUp('node-2.cvm')).toBe(true);
  });
});

describe('Stargate', () => {
  it('owns vDisks through backend.acquire and releases them when ownership moves', () => {
    const h = harness('t1-ahv-flasharray');
    h.run(5);
    expect(backend(h, 'node-1.cvm').acquired.has('node-1.vm-1.vdisk-1')).toBe(true);
    h.act('cvm.stop-stargate', 'node-1.cvm');
    h.run(10);
    const owner = String(h.f('node-1.vm-1', 'ownerCvm'));
    expect(owner).not.toBe('node-1.cvm');
    expect(h.cluster.vdiskOwner('node-1.vm-1.vdisk-1')).toBe(owner);
    expect(backend(h, owner).acquired.has('node-1.vm-1.vdisk-1')).toBe(true);
    h.act('cvm.start-stargate', 'node-1.cvm');
    h.run(P.redirector.failbackStableS.value + P.redirector.redirectStallS.value + 3);
    expect(h.f('node-1.vm-1', 'ownerCvm')).toBe('node-1.cvm');
    expect(backend(h, owner).acquired.has('node-1.vm-1.vdisk-1')).toBe(false);
    expect(backend(h, 'node-1.cvm').acquired.has('node-1.vm-1.vdisk-1')).toBe(true);
  });

  it('refuses writes without ZK quorum (minority side) but still serves reads', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('host.isolate', 'node-2');
    h.run(2);
    const b = backend(h, 'node-2.cvm');
    const from = b.submitted.length;
    h.run(5);
    const later = b.submitted.slice(from);
    expect(later.some((r) => r.op === 'read')).toBe(true);
    expect(later.some((r) => r.op === 'write')).toBe(false);
    expect(h.f('node-2.cvm', 'stargate')).toBe('unhealthy');
  });

  it('refuses IO from a fenced host (ClusterView.isHostFenced)', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    const b = backend(h, 'node-2.cvm');
    const from = b.submitted.length;
    h.run(1);
    expect(b.submitted.length).toBeGreaterThan(from);
    // Force the fence (as AHV HA does at T+60) and check the Stargate serves nothing from it.
    const reg = h.cluster as unknown as { haOf(host: string): { state: string } };
    reg.haOf('node-2').state = 'fenced';
    expect(h.cluster.isHostFenced('node-2')).toBe(true);
    expect(h.cluster.isStargateUp('node-2.cvm')).toBe(false);
    const before = b.submitted.length;
    h.run(1);
    expect(b.submitted.length).toBe(before);
  });

  it('exposes CVM endpoints to E/G through the ClusterView', () => {
    const t1 = harness('t1-ahv-flasharray');
    expect(t1.cluster.cvmIds()).toEqual([1, 2, 3, 4].map((n) => `node-${n}.cvm`));
    expect(t1.cluster.cvmDataEndpoint('node-1.cvm')).toBe('node-1.cvm.mgmt');
    expect(t1.cluster.cvmStorageEndpoints('node-1.cvm')).toEqual([
      'node-1.cvm.storage-a',
      'node-1.cvm.storage-b',
    ]);
    const perFabric = harness('t1-ahv-flasharray', { 'storage-vswitch-layout': 'per-fabric' });
    expect(perFabric.cluster.cvmStorageEndpoints('node-2.cvm')).toHaveLength(2);
    const seg = harness('t2-hci-ahv', { 'backplane-segmentation': true });
    expect(seg.cluster.cvmDataEndpoint('node-1.cvm')).toBe('node-1.cvm.backplane');
    expect(seg.cluster.zkQuorum()).toBe(true);
    expect(seg.cluster.metadataAvailable()).toBe(true);
  });
});

describe('CVM reboot', () => {
  it('reboot restarts services after cvmBootS; VMs are redirected meanwhile', () => {
    const h = harness('t2-hci-ahv');
    h.run(10);
    h.act('reboot', 'node-3.cvm');
    h.run(1);
    expect(h.f('node-3.cvm', 'power')).toBe('booting');
    h.run(BOOT);
    expect(h.firstAt('stargate.up', 'node-3.cvm')).toBe(T + BOOT);
    expect(vmState(h, 'node-3.vm-1')).toBe('running');
    expect(h.firstAt('ha.vm.restarted')).toBeNull();
  });
});
