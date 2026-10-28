/**
 * FlashArray HA, reservations, interfaces and the mgmt API, run headless on T1 / T1-lab through
 * `loadSimulation` with stub CVMs (tests/domain/nvme-tcp/stub.ts). Timings come from the profile.
 */
import { describe, expect, it } from 'vitest';
import { current } from '../../../src/domain/versions/profiles/current';
import type { SimEvent, Snapshot } from '../../../src/engine/types';
import { type Loaded, loadWithStubs, pathsOf } from '../nvme-tcp/stub';

const FA = current.flasharray;
const ES = current.externalStorage;
const KATO = ES.keepAliveTimeoutS.value;
const CQT = ES.commandQuiesceTimeS.value;
const RECONNECT = ES.reconnectDelayS.value;
/** In-flight IO on a silently lost path retries k × KATO + CQT after its last exchange (§6.4c). */
const HOLD = ES.lostPathHoldKatoMultiplier.value * KATO + CQT;
const T0 = 10;
const T1 = 't1-ahv-flasharray';
const CVMS = [1, 2, 3, 4].map((n) => `node-${n}.cvm`);

const f = (s: Snapshot, id: string) => s.devices[id]?.fields ?? {};
const faView = (r: Loaded) => f(r.sim.getSnapshot(), 'fa');
const ctrl = (r: Loaded, id: string) => f(r.sim.getSnapshot(), id);
const firstAt = (r: Loaded, code: string, device?: string): number | undefined =>
  r.events(code).find((e) => device === undefined || e.deviceId === device)?.t;

function runTo(r: Loaded, t: number, each?: (s: Snapshot) => void): void {
  while (r.sim.getSnapshot().simTime < t) each?.(r.sim.tick()) ?? r.sim.tick();
}

/** Run, recording the worst `pauseS` and per-CVM pending IO age. */
function watch(r: Loaded, t: number) {
  let maxPause = 0;
  let maxPending = 0;
  let servingFalse = 0;
  while (r.sim.getSnapshot().simTime < t) {
    const s = r.sim.tick();
    maxPause = Math.max(maxPause, Number(f(s, 'fa').pauseS));
    if (f(s, 'fa').ioServing === false) servingFalse++;
    for (const st of r.stubs.values()) maxPending = Math.max(maxPending, st.maxPendingS(s.simTime));
  }
  return { maxPause, maxPending, servingFalse };
}

function inOrder(events: readonly SimEvent[], steps: readonly [string, string][]): boolean {
  let i = 0;
  for (const e of events) {
    const want = steps[i];
    if (!want) break;
    if (e.code === want[0] && e.deviceId === want[1]) i++;
  }
  return i === steps.length;
}

/** Paths whose FA end is on `ctrlId` are exactly the non-live ones, for every CVM. */
function onlyLostOn(r: Loaded, match: (faIface: string) => boolean): boolean {
  return CVMS.every((c) => {
    const ps = Object.entries(pathsOf(r.sim, c));
    const lost = ps.filter(([id]) => match(id.split('~')[1] ?? ''));
    const kept = ps.filter(([id]) => !match(id.split('~')[1] ?? ''));
    return (
      lost.length > 0 &&
      kept.length > 0 &&
      lost.every(([, s]) => s !== 'live') &&
      kept.every(([, s]) => s === 'live')
    );
  });
}

const allLive = (r: Loaded) =>
  CVMS.every((c) => Object.values(pathsOf(r.sim, c)).every((s) => s === 'live'));

describe('steady state (T1)', () => {
  it('every CVM has 4 ANA Optimized paths, CT0 is primary, IO completes', () => {
    const r = loadWithStubs(T1);
    runTo(r, T0);
    for (const c of CVMS) expect(Object.keys(pathsOf(r.sim, c))).toHaveLength(4);
    expect(allLive(r)).toBe(true);
    expect(faView(r)).toMatchObject({
      ioServing: true,
      pauseS: 0,
      primary: 'fa.ct0',
      mgmtApi: 'up',
    });
    expect(ctrl(r, 'fa.ct0')).toMatchObject({ role: 'primary', state: 'up' });
    expect(ctrl(r, 'fa.ct1')).toMatchObject({ role: 'secondary', state: 'up' });
    expect(f(r.sim.getSnapshot(), 'fa.ct1.eth11.v20')).toMatchObject({ enabled: true, oper: 'up' });
    for (const st of r.stubs.values()) {
      expect(st.done.length).toBeGreaterThan(0);
      expect(st.errors()).toHaveLength(0);
      expect(st.maxPendingS(T0)).toBe(0);
    }
    expect(r.events('switch.flow-control.unsupported')).toHaveLength(0);
  });
});

describe('controller HA', () => {
  it('primary crash: claim expiry, promotion within the crash pause, CT0 ports gone', () => {
    const r = loadWithStubs(T1);
    runTo(r, T0);
    r.sim.applyAction({ kind: 'fail', target: 'fa.ct0' });
    const w = watch(r, T0 + 60);
    const crash = T0 + 1;
    const expired = firstAt(r, 'fa.claim.expired', 'fa.ct1');
    expect(expired).toBe(crash + FA.claimExpiryDetectS.value);
    const done = firstAt(r, 'fa.promotion.complete', 'fa.ct1') ?? -1;
    const pause = Math.min(
      FA.primaryCrashPauseS.value,
      FA.claimExpiryDetectS.value + FA.promotionMaxS.value,
    );
    expect(done - crash).toBe(pause);
    expect(w.maxPause).toBe(pause);
    expect(w.servingFalse).toBe(pause);
    expect(faView(r)).toMatchObject({ ioServing: true, primary: 'fa.ct1' });
    expect(ctrl(r, 'fa.ct0')).toMatchObject({ role: 'offline', state: 'crashed' });
    // Silent loss: CT0's paths go after KATO.
    expect(firstAt(r, 'nvme.path.lost')).toBe(crash - 1 + KATO);
    expect(onlyLostOn(r, (i) => i.startsWith('fa.ct0.'))).toBe(true);
    // The mgmt VIP follows the primary.
    expect(r.sim.net.endpoint('fa.vir0')?.attach.id).toBe('fa.ct1.eth0');
    expect(faView(r).mgmtApi).toBe('up');
    expect(w.maxPending).toBeLessThanOrEqual(Math.max(pause, HOLD));
    expect(
      inOrder(r.events(), [
        ['device.failed', 'fa.ct0'],
        ['fa.claim.expired', 'fa.ct1'],
        ['fa.promotion.start', 'fa.ct1'],
        ['fa.promotion.complete', 'fa.ct1'],
      ]),
    ).toBe(true);
    const lost = r.events('nvme.path.lost')[0];
    const failed = r.events('device.failed')[0];
    expect(lost?.causeIds).toEqual([`e${failed?.seq}`]);
    for (const st of r.stubs.values()) expect(st.errors()).toHaveLength(0);
  });

  it('secondary crash: no array-wide pause, only its paths go away', () => {
    const r = loadWithStubs(T1);
    runTo(r, T0);
    r.sim.applyAction({ kind: 'fail', target: 'fa.ct1' });
    const w = watch(r, T0 + 50);
    expect(w.maxPause).toBe(0);
    expect(w.servingFalse).toBe(0);
    expect(r.events('fa.promotion.start')).toHaveLength(0);
    expect(r.events('fa.claim.expired')).toHaveLength(0);
    expect(ctrl(r, 'fa.ct0').role).toBe('primary');
    expect(onlyLostOn(r, (i) => i.startsWith('fa.ct1.'))).toBe(true);
    expect(w.maxPending).toBeLessThanOrEqual(HOLD);
    // Recovering CT1 brings it back as secondary and its paths reconnect.
    r.sim.applyAction({ kind: 'recover', target: 'fa.ct1' });
    runTo(r, T0 + 50 + RECONNECT + 1);
    expect(ctrl(r, 'fa.ct1')).toMatchObject({ role: 'secondary', state: 'up' });
    expect(allLive(r)).toBe(true);
  });

  it('IO stall: IO delay timeout, giveback, then promotion (pause = delay + promotion)', () => {
    const r = loadWithStubs(T1);
    runTo(r, T0);
    r.sim.applyAction({ kind: 'fa.io-stall', target: 'fa.ct0' });
    const w = watch(r, T0 + 60);
    const stall = T0 + 1;
    expect(firstAt(r, 'fa.io-delay.timeout', 'fa.ct0')).toBe(stall + FA.ioDelayTimeoutS.value);
    const promo = firstAt(r, 'fa.promotion.complete', 'fa.ct1');
    const total = FA.ioDelayTimeoutS.value + FA.promotionMaxS.value;
    expect((promo ?? 0) - stall).toBe(total);
    expect(total).toBeLessThanOrEqual(FA.failoverObjectiveS.value);
    expect(w.maxPause).toBe(total);
    expect(
      inOrder(r.events(), [
        ['fa.io-delay.timeout', 'fa.ct0'],
        ['fa.giveback', 'fa.ct0'],
        ['fa.promotion.start', 'fa.ct1'],
        ['fa.promotion.complete', 'fa.ct1'],
      ]),
    ).toBe(true);
    expect(ctrl(r, 'fa.ct0')).toMatchObject({ role: 'secondary', state: 'up' });
    // Keep-alives are answered throughout: no path is lost by a stall.
    expect(r.events('nvme.path.lost')).toHaveLength(0);
    expect(w.maxPending).toBeLessThanOrEqual(total);
    for (const st of r.stubs.values()) expect(st.errors()).toHaveLength(0);
  });

  it('planned failover pauses for plannedFailoverPauseS and moves the VIP', () => {
    const r = loadWithStubs(T1);
    runTo(r, T0);
    r.sim.applyAction({ kind: 'fa.controller.failover', target: 'fa' });
    const w = watch(r, T0 + 40);
    expect(w.maxPause).toBe(FA.plannedFailoverPauseS.value);
    expect(firstAt(r, 'fa.giveback', 'fa.ct0')).toBe(T0 + 1);
    expect(firstAt(r, 'fa.promotion.complete', 'fa.ct1')).toBe(
      T0 + 1 + FA.plannedFailoverPauseS.value,
    );
    expect(r.sim.net.endpoint('fa.vir0')?.attach.id).toBe('fa.ct1.eth0');
    expect(r.events('nvme.path.lost')).toHaveLength(0);
  });

  it('NDU: secondary reboot, failover, old-primary reboot, no failback', () => {
    const r = loadWithStubs(T1, {}, { perTick: 2, depth: 8 });
    runTo(r, T0);
    r.sim.applyAction({ kind: 'fa.ndu', target: 'fa' });
    const reboot = FA.controllerRebootS.value;
    const w = watch(r, T0 + 2 * reboot + 200);
    expect(
      inOrder(r.events(), [
        ['fa.ndu.start', 'fa'],
        ['fa.controller.rebooting', 'fa.ct1'],
        ['fa.controller.online', 'fa.ct1'],
        ['fa.giveback', 'fa.ct0'],
        ['fa.promotion.complete', 'fa.ct1'],
        ['fa.controller.rebooting', 'fa.ct0'],
        ['fa.controller.online', 'fa.ct0'],
        ['fa.ndu.complete', 'fa'],
      ]),
    ).toBe(true);
    const r1 = firstAt(r, 'fa.controller.rebooting', 'fa.ct1') ?? -1;
    expect(firstAt(r, 'fa.controller.online', 'fa.ct1')).toBe(r1 + reboot);
    // A graceful reboot closes the connections: CT1's paths are lost at once, not after KATO.
    expect(firstAt(r, 'nvme.path.lost')).toBe(r1);
    // The failover waits until every host has reconnected to the upgraded controller.
    const gb = firstAt(r, 'fa.giveback', 'fa.ct0') ?? -1;
    expect(gb).toBeGreaterThan(r1 + reboot);
    expect(gb).toBeLessThanOrEqual(r1 + reboot + RECONNECT);
    expect(r.events('nvme.all-paths.lost')).toHaveLength(0);
    expect(w.maxPause).toBe(FA.plannedFailoverPauseS.value);
    // In-flight IO on a closed connection waits CQT only (NVMe 2.1 §9.6.2 step 2c), not the
    // k × KATO + CQT of a silent loss; new IO moved to the peer's paths at once.
    expect(w.maxPending).toBeLessThanOrEqual(Math.max(FA.plannedFailoverPauseS.value, CQT + 1));
    expect(w.maxPending).toBeLessThan(HOLD);
    expect(ctrl(r, 'fa.ct1')).toMatchObject({ role: 'primary', state: 'up' });
    expect(ctrl(r, 'fa.ct0')).toMatchObject({ role: 'secondary', state: 'up' });
    expect(allLive(r)).toBe(true);
    for (const st of r.stubs.values()) expect(st.errors()).toHaveLength(0);
  });

  it('whole array lost: IO retries until it returns, then everything reconnects', () => {
    const r = loadWithStubs(T1, {}, { perTick: 2, depth: 8 });
    runTo(r, T0);
    r.sim.applyAction({ kind: 'fail', target: 'fa' });
    runTo(r, T0 + 120);
    for (const c of CVMS)
      expect(r.events('nvme.all-paths.lost').some((e) => e.deviceId === c)).toBe(true);
    expect(faView(r)).toMatchObject({ ioServing: false, primary: null, mgmtApi: 'unreachable' });
    for (const st of r.stubs.values()) expect(st.errors()).toHaveLength(0);
    r.sim.applyAction({ kind: 'recover', target: 'fa' });
    runTo(r, T0 + 120 + RECONNECT + 2);
    expect(faView(r)).toMatchObject({ ioServing: true, primary: 'fa.ct0' });
    expect(allLive(r)).toBe(true);
    for (const st of r.stubs.values()) expect(st.maxPendingS(r.sim.getSnapshot().simTime)).toBe(0);
  });

  it('rejects an NDU while a controller is down', () => {
    const r = loadWithStubs(T1);
    runTo(r, T0);
    r.sim.applyAction({ kind: 'fail', target: 'fa.ct1' });
    r.sim.tick();
    r.sim.applyAction({ kind: 'fa.ndu', target: 'fa' });
    r.sim.tick();
    expect(r.events('action.rejected')).toHaveLength(1);
    expect(r.events('fa.ndu.start')).toHaveLength(0);
  });
});

describe('reservations (fencing)', () => {
  it('rejects IO from a CVM that does not hold the vDisk reservation', () => {
    const r = loadWithStubs(T1, {}, { perTick: 0 });
    const a = r.cvm(1);
    const b = r.cvm(2);
    const vdisk = 'node-1.vm-1.vd-1';
    runTo(r, 2);
    // One-off hooks on the stubs: issue a write / acquire the reservation at a given tick.
    const issue = (st: typeof a, at: number) => {
      const orig = st.emit.bind(st);
      st.emit = (ctx) => {
        orig(ctx);
        if (ctx.now === at) st.submit('node-1.vm-1', ctx, 'write');
      };
    };
    const acquire = (st: typeof a, at: number) => {
      const orig = st.preTick.bind(st);
      st.preTick = (ctx) => {
        orig(ctx);
        if (ctx.now === at) st.backend.acquire(vdisk, ctx);
      };
    };
    acquire(a, 3);
    issue(a, 4);
    issue(b, 5);
    runTo(r, 6);
    expect(r.backend(1).nvme.holdsReservation(vdisk)).toBe(true);
    expect(r.part.model.reservations.get(vdisk)).toBe('node-1.cvm');
    expect(a.done.map((c) => c.outcome.status)).toEqual(['ok']);
    expect(b.done.map((c) => c.outcome)).toEqual([
      { status: 'error', reason: 'reservation-conflict' },
    ]);
    expect(r.events('nvme.io.reservation-conflict').map((e) => e.deviceId)).toEqual(['node-2.cvm']);
    // CVM 2 preempts (e.g. after a redirect): now CVM 1 is fenced.
    acquire(b, 7);
    issue(b, 8);
    issue(a, 8);
    runTo(r, 9);
    expect(r.part.model.reservations.get(vdisk)).toBe('node-2.cvm');
    expect(b.done.at(-1)?.outcome.status).toBe('ok');
    expect(a.done.at(-1)?.outcome).toEqual({ status: 'error', reason: 'reservation-conflict' });
  });
});

describe('storage NIC loss: strict A/B vs tagged on both switches', () => {
  it('strict A/B: the VLAN-A vNIC has nowhere to go, its paths are lost after KATO', () => {
    const r = loadWithStubs(T1, { 'vlan-placement': 'strict-ab' });
    runTo(r, T0);
    r.sim.applyAction({ kind: 'fail', target: 'node-1.eth1' });
    const w = watch(r, T0 + HOLD + 10);
    const lost = r.events('nvme.path.lost');
    expect(new Set(lost.map((e) => e.deviceId))).toEqual(new Set(['node-1.cvm']));
    expect(lost.map((e) => e.text.split(' ')[0]).sort()).toEqual([
      'node-1.cvm.storage-a~fa.ct0.eth10.v10',
      'node-1.cvm.storage-a~fa.ct1.eth10.v10',
    ]);
    expect(lost.every((e) => e.t <= T0 + 1 + KATO)).toBe(true);
    expect(w.maxPending).toBeLessThanOrEqual(HOLD);
    for (const st of r.stubs.values()) expect(st.errors()).toHaveLength(0);
  });

  it('tagged both: the bond moves the vNIC and no NVMe path is lost', () => {
    // The moved vNIC lands on sw-b while the VLAN-A FA ports are on sw-a, so the ISL must carry
    // the storage VLANs for the bond to save the path.
    const r = loadWithStubs(T1, {
      'vlan-placement': 'tagged-both',
      'isl-storage-vlans': 'allowed',
    });
    runTo(r, T0);
    r.sim.applyAction({ kind: 'fail', target: 'node-1.eth1' });
    const w = watch(r, T0 + KATO + CQT + 10);
    expect(r.events('nvme.path.lost')).toHaveLength(0);
    expect(allLive(r)).toBe(true);
    expect(w.maxPending).toBe(0);
    const up = r.backend(1).uplinksFor('node-1.vm-1.vd-1');
    expect(up).toEqual(['node-1.eth3']);
  });
});

describe('T1-lab', () => {
  it('disabling one FA data IP loses exactly that path on every CVM; re-enabling restores it', () => {
    const r = loadWithStubs('t1-lab');
    const ip = 'fa.ct0.eth10.v10';
    const cvms = ['node-1.cvm', 'node-2.cvm', 'node-3.cvm'];
    runTo(r, T0);
    for (const c of cvms) expect(Object.keys(pathsOf(r.sim, c))).toHaveLength(8);
    r.sim.applyAction({ kind: 'fa.interface.disable', target: ip });
    const w = watch(r, T0 + 60);
    expect(f(r.sim.getSnapshot(), ip)).toMatchObject({ enabled: false, oper: 'down' });
    for (const c of cvms) {
      const ps = pathsOf(r.sim, c);
      for (const [id, st] of Object.entries(ps))
        expect(st).toBe(id.endsWith(`~${ip}`) ? 'lost' : 'live');
    }
    // Purity closes the IP's connections: lost on the next frame to it (fast), before KATO.
    const lostTimes = r.events('nvme.path.lost').map((e) => e.t);
    expect(lostTimes).toHaveLength(cvms.length);
    expect(lostTimes.every((t) => t <= T0 + Math.ceil(KATO / 2) && t < T0 + 1 + KATO)).toBe(true);
    expect(r.events('nvme.path.lost').every((e) => /refused/.test(e.text))).toBe(true);
    expect(w.maxPending).toBeLessThanOrEqual(KATO + CQT);
    r.sim.applyAction({ kind: 'fa.interface.enable', target: ip });
    runTo(r, T0 + 60 + RECONNECT + 1);
    for (const c of cvms)
      expect(Object.values(pathsOf(r.sim, c)).every((s) => s === 'live')).toBe(true);
    for (const st of r.stubs.values()) expect(st.errors()).toHaveLength(0);
  });
});

describe('management API', () => {
  it('snapshots fail while the VIP is unreachable and succeed after; IO is unaffected', () => {
    const r = loadWithStubs(T1);
    const vm = 'node-1.vm-1';
    runTo(r, T0);
    r.sim.applyAction({ kind: 'fa.interface.disable', target: 'fa.vir0' });
    runTo(r, T0 + 3);
    expect(faView(r).mgmtApi).toBe('unreachable');
    r.sim.applyAction({ kind: 'vm.snapshot', target: vm });
    runTo(r, T0 + 5);
    expect(r.events('mgmt.task.failed').map((e) => e.deviceId)).toEqual([vm]);
    r.sim.applyAction({ kind: 'fa.interface.enable', target: 'fa.vir0' });
    runTo(r, T0 + 7);
    expect(faView(r).mgmtApi).toBe('up');
    r.sim.applyAction({ kind: 'vm.snapshot', target: vm });
    runTo(r, T0 + 9);
    expect(r.events('mgmt.task.succeeded').map((e) => e.deviceId)).toEqual([vm]);
    expect(allLive(r)).toBe(true);
    for (const st of r.stubs.values()) expect(st.maxPendingS(T0 + 9)).toBe(0);
  });
});

describe('flow control', () => {
  it('flags every switch with flow control on, once, at the first tick', () => {
    const r = loadWithStubs(T1, { 'flow-control': 'pfc' });
    runTo(r, 5);
    const ev = r.events('switch.flow-control.unsupported');
    expect(ev.map((e) => [e.t, e.deviceId, e.severity])).toEqual([
      [1, 'sw-a', 'warn'],
      [1, 'sw-b', 'warn'],
    ]);
    expect(ev[0]?.cite).toEqual(['everpure-nutanix-net-bp']);
  });
});

describe('path usage (SPEC §6.4b)', () => {
  it('MAC pinning + active-active: IO uses every path, uplinks are the vNICs’ pinned members', () => {
    const r = loadWithStubs(T1, {
      'vlan-placement': 'tagged-both',
      'vs1-bond-mode': 'balance-slb',
    });
    runTo(r, T0);
    const b = r.backend(1);
    expect(b.nvme.pathsFor('node-1.vm-1.vd-1')).toHaveLength(4);
    // `pathsFor` is path ids only; NICs come from `uplinksFor` (StorageBackend contract).
    expect(b.pathsFor('node-1.vm-1.vd-1')).toEqual(b.nvme.pathsFor('node-1.vm-1.vd-1'));
    const bond = r.sim.net.bond('node-1.vs1');
    const pinned = new Set(
      ['node-1.cvm.storage-a', 'node-1.cvm.storage-b'].map((ep) => {
        const e = r.sim.net.endpoint(ep);
        return e ? bond?.pinnedMember(e.mac, e.vlan) : undefined;
      }),
    );
    expect(new Set(b.uplinksFor('node-1.vm-1.vd-1'))).toEqual(pinned);
  });

  it('LACP + active-active: the paths’ connections hash across both uplinks', () => {
    const r = loadWithStubs(T1, {
      'vlan-placement': 'tagged-both',
      'vs1-bond-mode': 'balance-tcp',
      mlag: true,
    });
    runTo(r, T0);
    expect(r.backend(1).uplinksFor('node-1.vm-1.vd-1')).toEqual(['node-1.eth1', 'node-1.eth3']);
  });

  it('active-passive: one path per vDisk', () => {
    const r = loadWithStubs(T1, { 'multipath-policy': 'active-passive' });
    runTo(r, T0);
    expect(r.backend(1).nvme.pathsFor('node-1.vm-1.vd-1')).toHaveLength(1);
    expect(r.backend(1).nvme.policy).toBe('active-passive');
  });
});

describe('determinism', () => {
  it('the same actions produce the same event log', () => {
    const run = () => {
      const r = loadWithStubs(T1, { 'vs1-bond-mode': 'balance-tcp', mlag: true });
      runTo(r, T0);
      r.sim.applyAction({ kind: 'fail', target: 'fa.ct0' });
      r.sim.applyAction({ kind: 'fail', target: 'node-2.eth1' });
      runTo(r, T0 + 60);
      return r.events().map((e) => `${e.t} ${e.code}@${e.deviceId} ${e.text}`);
    };
    expect(run()).toEqual(run());
  });
});

describe('scenario-shaped checks', () => {
  it('T1-16: a forced rebalance strands the VLAN-A vNIC; its paths are lost after KATO', () => {
    const r = loadWithStubs(T1, { 'vlan-placement': 'strict-ab', 'vs1-bond-mode': 'balance-slb' });
    runTo(r, T0);
    r.sim.applyAction({
      kind: 'vswitch.rebalance',
      target: 'node-1.vs1',
      params: { vnic: 'node-1.cvm.storage-a', member: 'node-1.eth3' },
    });
    const w = watch(r, T0 + HOLD + 5);
    expect(r.events('net.bond.rebalance').map((e) => e.deviceId)).toEqual(['node-1.vs1']);
    expect(r.events('net.link.down')).toHaveLength(0);
    const lost = r.events('nvme.path.lost');
    expect(lost.map((e) => e.text.split(' ')[0]).sort()).toEqual([
      'node-1.cvm.storage-a~fa.ct0.eth10.v10',
      'node-1.cvm.storage-a~fa.ct1.eth10.v10',
    ]);
    expect(lost.every((e) => e.t > T0 + 1 && e.t <= T0 + 1 + KATO)).toBe(true);
    expect(w.maxPending).toBeLessThanOrEqual(HOLD);
  });

  it('T1-12: MTU mismatch keeps every path up while large IO never completes', () => {
    const r = loadWithStubs(T1, { mtu: '1500-mismatch' });
    runTo(r, 70);
    expect(allLive(r)).toBe(true);
    expect(r.events('nvme.path.lost')).toHaveLength(0);
    expect(r.cvm(1).maxPendingS(70)).toBeGreaterThanOrEqual(69);
    expect(r.cvm(1).errors()).toHaveLength(0);
    expect(r.events('nvme.io.timeout').length).toBeGreaterThan(0);
  });

  it('T1-lab-3: pruning both storage VLANs on a node port loses every array path there', () => {
    const r = loadWithStubs('t1-lab');
    runTo(r, T0);
    for (const vlan of [10, 20]) {
      r.sim.applyAction({
        kind: 'switch.port.prune-vlan',
        target: 'l-node-1.eth0--sw-a',
        params: { vlan },
      });
    }
    runTo(r, T0 + 1 + KATO + 1);
    expect(r.events('nvme.all-paths.lost').map((e) => e.deviceId)).toEqual(['node-1.cvm']);
    expect(r.backend(1).health()).toBe('unavailable');
    expect(r.backend(2).health()).toBe('ok');
    runTo(r, T0 + 200);
    expect(r.cvm(1).errors()).toHaveLength(0);
    expect(r.cvm(1).maxPendingS(T0 + 200)).toBeGreaterThan(180);
  });
});
