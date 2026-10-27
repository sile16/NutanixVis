/**
 * VM state machine in isolation: a bare engine simulation with one VM and a stub `VmEnv`
 * (SPEC §6.1; docs/view-fields.md `vm`). Timers come from the profile.
 */
import { describe, expect, it } from 'vitest';
import type { Ctx, IoRequest } from '../../../src/domain/contracts';
import { current as P } from '../../../src/domain/versions/profiles/current';
import { WORKLOAD } from '../../../src/domain/workload/io';
import { type IoTarget, Vm, type VmEnv } from '../../../src/domain/workload/vm';
import { createSimulation } from '../../../src/engine/sim';

type Mode = 'ok' | 'stall' | 'retry' | 'error';

function setup(opts: { forceShutdownS?: number } = {}) {
  const st = {
    alive: true,
    fenced: false,
    cutOff: false,
    lost: false,
    mode: 'ok' as Mode,
    target: { status: 'ready', cvm: 'node-1.cvm', session: 1 } as IoTarget,
    sent: [] as IoRequest[],
  };
  let vm: Vm | undefined;
  const env: VmEnv = {
    hostAlive: () => st.alive,
    hostFenced: () => st.fenced,
    hostCutOff: () => st.cutOff,
    target: () => st.target,
    send: (_host, _vm, io, ctx: Ctx) => {
      st.sent.push(io);
      if (st.mode === 'ok') vm?.onReply(io.id, { status: 'ok', latencyMs: 1 }, 'none', ctx);
      if (st.mode === 'retry') vm?.onReply(io.id, { status: 'retry', reason: 'x' }, 'none', ctx);
      if (st.mode === 'error') vm?.onReply(io.id, { status: 'error', reason: 'x' }, 'none', ctx);
      return 'none';
    },
    ownerCvm: () => 'node-1.cvm',
    storageUse: () => ({ paths: ['a~b'], uplinks: ['node-1.eth1'] }),
    storageLost: () => st.lost,
    hostOfNic: () => undefined,
  };
  vm = new Vm(
    {
      id: 'node-1.vm-1',
      label: 'VM 1-1',
      host: 'node-1',
      vdisks: ['node-1.vm-1.vdisk-1'],
      pathLossForceShutdownS: opts.forceShutdownS ?? null,
    },
    env,
  );
  const sim = createSimulation({
    devices: [vm],
    profile: P,
    seed: 1,
    topologyId: 'unit',
    versions: { nutanix: 'n', profileId: P.id },
  });
  const f = (k: string) => sim.getSnapshot().devices['node-1.vm-1']?.fields[k];
  const codes = (code: string) => sim.eventLog().filter((e) => e.code === code);
  return { st, vm, sim, f, codes };
}

describe('VM IO generator', () => {
  it('issues reads and writes each tick in both size classes, served → running', () => {
    const { st, sim, f } = setup();
    sim.tick(4);
    const perTick = WORKLOAD.readsPerTick.value + WORKLOAD.writesPerTick.value;
    expect(st.sent).toHaveLength(4 * perTick);
    expect(new Set(st.sent.map((r) => r.size))).toEqual(new Set(['small', 'large']));
    expect(new Set(st.sent.map((r) => r.op))).toEqual(new Set(['read', 'write']));
    expect(f('state')).toBe('running');
    expect(f('ioPendingS')).toBe(0);
    expect(f('ioPaths')).toBe('["a~b"]');
    expect(f('ioUplinks')).toBe('["node-1.eth1"]');
    expect(f('instances')).toBe('["node-1"]');
  });

  it('caps outstanding IO at the queue depth and reports the oldest wait', () => {
    const { st, sim, f } = setup();
    st.mode = 'stall';
    sim.tick(20);
    expect(f('outstandingIo')).toBe(WORKLOAD.queueDepth.value);
    expect(f('state')).toBe('io-stalled');
    expect(f('ioPendingS')).toBe(19);
    expect(f('readPendingS')).toBe(19);
  });

  it('IO issued this tick and still in flight is not a stall; a tick later it is', () => {
    const { st, sim, f } = setup();
    st.mode = 'stall';
    sim.tick(1);
    expect(f('outstandingIo')).toBeGreaterThan(0);
    expect(f('ioPendingS')).toBe(0);
    expect(f('state')).toBe('running');
    sim.tick(1);
    expect(f('ioPendingS')).toBe(1);
    expect(f('state')).toBe('io-stalled');
  });

  it('re-issues outstanding IO on a new session (redirect)', () => {
    const { st, sim } = setup();
    st.mode = 'stall';
    sim.tick(2);
    const n = st.sent.length;
    st.mode = 'ok';
    st.target = { status: 'ready', cvm: 'node-2.cvm', session: 2 };
    sim.tick(1);
    expect(st.sent.length - n).toBeGreaterThan(WORKLOAD.readsPerTick.value);
  });

  it('a held session (re-login stall) sends nothing and is not a failed IO', () => {
    const { st, sim, f, codes } = setup();
    st.target = { status: 'held' };
    st.cutOff = true;
    sim.tick(P.ahvHa.isolatedVmSelfTerminateS.value + 5);
    expect(st.sent).toHaveLength(0);
    expect(f('state')).toBe('io-stalled');
    expect(codes('ha.vm.self-terminated')).toHaveLength(0);
  });
});

describe('guest timeout', () => {
  it('emits vm.io.guest-timeout once the oldest IO is older than linuxScsiTimeoutS', () => {
    const { st, sim, codes } = setup();
    st.mode = 'stall';
    const limit = P.guest.linuxScsiTimeoutS.value;
    // IO issued at t=1; pending = t − 1.
    sim.tick(limit + 1);
    expect(codes('vm.io.guest-timeout')).toHaveLength(0);
    sim.tick(1);
    expect(codes('vm.io.guest-timeout').map((e) => e.t)).toEqual([limit + 2]);
    sim.tick(10);
    expect(codes('vm.io.guest-timeout')).toHaveLength(1);
  });
});

describe('isolation self-termination (Bible 5b)', () => {
  it('fires isolatedVmSelfTerminateS after the first failed IO, only while cut off', () => {
    const { st, sim, f, codes } = setup();
    sim.tick(2);
    st.target = { status: 'no-path' };
    st.cutOff = true;
    // First failed IO at t=3.
    const due = 3 + P.ahvHa.isolatedVmSelfTerminateS.value;
    sim.tick(due - 1 - 2);
    expect(codes('ha.vm.self-terminated')).toHaveLength(0);
    sim.tick(1);
    expect(codes('ha.vm.self-terminated').map((e) => e.t)).toEqual([due]);
    expect(f('state')).toBe('crashed');
    expect(f('host')).toBeNull();
    expect(f('instances')).toBe('[]');
    expect(f('restartNeed')).toBe('ha');
  });

  it('never self-terminates without a quorum side (SPEC §14 #1)', () => {
    const { st, sim, codes, f } = setup();
    st.mode = 'retry';
    st.cutOff = false;
    sim.tick(200);
    expect(codes('ha.vm.self-terminated')).toHaveLength(0);
    expect(f('state')).toBe('io-stalled');
  });

  it('retried (refused) IO counts as failed; recovery clears the clock', () => {
    const { st, sim, codes } = setup();
    st.mode = 'retry';
    sim.tick(30);
    st.mode = 'ok';
    sim.tick(2);
    st.mode = 'retry';
    st.cutOff = true;
    sim.tick(P.ahvHa.isolatedVmSelfTerminateS.value - 1);
    expect(codes('ha.vm.self-terminated')).toHaveLength(0);
    sim.tick(2);
    expect(codes('ha.vm.self-terminated')).toHaveLength(1);
  });
});

describe('lifecycle', () => {
  it('crashes with its host; a fenced host never shows the VM running', () => {
    const { st, sim, f } = setup();
    sim.tick(1);
    st.fenced = true;
    sim.tick(1);
    expect(f('state')).toBe('io-stalled');
    st.fenced = false;
    st.alive = false;
    sim.tick(1);
    expect(f('state')).toBe('crashed');
    expect(f('instances')).toBe('[]');
  });

  it('a terminal IO error reaches the guest once per episode (vm.io.error)', () => {
    const { st, sim, codes } = setup();
    st.mode = 'error';
    sim.tick(5);
    expect(codes('vm.io.error')).toHaveLength(1);
  });

  it('path-loss force-shutdown fires at the per-VM timeout, counted from the first stuck IO', () => {
    const { st, sim, f, codes } = setup({ forceShutdownS: 60 });
    sim.tick(4);
    st.mode = 'stall';
    st.lost = true;
    // First stuck IO issued at t=5.
    sim.tick(5 + 60 - 1 - 4);
    expect(codes('vm.force-shutdown')).toHaveLength(0);
    sim.tick(1);
    expect(codes('vm.force-shutdown').map((e) => e.t)).toEqual([65]);
    expect(f('state')).toBe('off');
    expect(f('restartNeed')).toBe('next-cycle');
  });

  it('without a force-shutdown timeout the VM retries forever (DEPLOY-GUIDE default)', () => {
    const { st, sim, codes, f } = setup();
    st.mode = 'stall';
    st.lost = true;
    sim.tick(400);
    expect(codes('vm.force-shutdown')).toHaveLength(0);
    expect(f('state')).toBe('io-stalled');
  });

  it('pause and power-off', () => {
    const { vm, sim, f, st } = setup();
    vm.pause(true);
    sim.tick(2);
    expect(f('state')).toBe('paused');
    expect(st.sent).toHaveLength(0);
    vm.pause(false);
    vm.powerOff();
    sim.tick(1);
    expect(f('state')).toBe('off');
    expect(f('restartNeed')).toBe('none');
  });
});
