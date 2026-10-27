/**
 * NVMe/TCP initiator state machine (SPEC §6.4c) on a minimal fabric with a fake target. Timing is
 * asserted at its boundaries: keep-alive cadence, loss at exactly KATO, in-flight retry at
 * KATO + CQT, reconnect cadence and controller deletion, all read from the profile.
 */
import { describe, expect, it } from 'vitest';
import { NvmeTcpInitiator } from '../../../src/domain/nvme-tcp/initiator';
import { RECONNECT_FOREVER } from '../../../src/domain/versions/cited';
import type { MultipathPolicy, Profile } from '../../../src/domain/versions/profile';
import { current } from '../../../src/domain/versions/profiles/current';
import { createSimulation, type EngineSimulation } from '../../../src/engine/sim';
import type { SimEvent } from '../../../src/engine/types';
import { device, type FabricOptions, fabric, VERSIONS } from '../../engine/helpers';
import { type FakeTarget, fakeTarget, StubCvm, type StubIo } from './stub';

const ES = current.externalStorage;
const KATO = ES.keepAliveTimeoutS.value;
const CQT = ES.commandQuiesceTimeS.value;
const RECONNECT = ES.reconnectDelayS.value;
const CTRL_LOSS = ES.controllerLossTimeoutS.value;
const IO_TIMEOUT = ES.ioTimeoutS.value;

const P0 = 'h1.cvm.ep10~tgt.ep0';
const P1 = 'h1.cvm.ep10~tgt.ep1';
const P20 = 'h1.cvm.ep20~tgt.ep20';

function withEs(patch: Partial<Profile['externalStorage']>): Profile {
  return { ...current, externalStorage: { ...current.externalStorage, ...patch } };
}

interface Rig {
  readonly sim: EngineSimulation;
  readonly init: NvmeTcpInitiator;
  readonly cvm: StubCvm;
  readonly tgt: FakeTarget;
  events(code: string): SimEvent[];
  runTo(t: number): void;
}

function rig(
  o: { profile?: Profile; policy?: MultipathPolicy; fabric?: FabricOptions; io?: StubIo } = {},
): Rig {
  const profile = o.profile ?? current;
  const init = new NvmeTcpInitiator({
    cvm: 'h1.cvm',
    profile,
    policy: o.policy ?? 'active-active',
    paths: [
      { local: 'h1.cvm.ep10', remote: 'tgt.ep0' },
      { local: 'h1.cvm.ep10', remote: 'tgt.ep1' },
      { local: 'h1.cvm.ep20', remote: 'tgt.ep20' },
    ],
  });
  const cvm = new StubCvm('h1.cvm', 'h1', init, ['vm1'], o.io);
  const tgt = fakeTarget('tgt');
  const sim = createSimulation<Profile>({
    devices: [device('h1', { kind: 'host' }), cvm, device('h2', { kind: 'host' }), tgt],
    network: fabric(o.fabric),
    profile,
    seed: 1,
    topologyId: 'test',
    versions: VERSIONS,
  });
  return {
    sim,
    init,
    cvm,
    tgt,
    events: (code) => sim.eventLog().filter((e) => e.code === code),
    runTo: (t) => {
      while (sim.getSnapshot().simTime < t) sim.tick();
    },
  };
}

const lostAt = (r: Rig, path: string) =>
  r.events('nvme.path.lost').find((e) => e.text.startsWith(path))?.t;

describe('keep-alive', () => {
  it('is sent on each admin queue every KATO/2', () => {
    const r = rig();
    const sends: number[] = [];
    for (let t = 1; t <= 10; t++) {
      const s = r.sim.tick();
      if (
        s.traces.some(
          (tr) => tr.kind === 'nvme-keepalive' && tr.src === 'h1.cvm.ep10' && tr.dst === 'tgt.ep0',
        )
      ) {
        sends.push(t);
      }
    }
    // KATO/2 = 2.5 s on a 1 s tick: 1, 3.5→3… the schedule averages KATO/2.
    expect(sends.length).toBe(Math.floor(10 / (KATO / 2)) + 1);
    for (let i = 1; i < sends.length; i++) {
      expect((sends[i] ?? 0) - (sends[i - 1] ?? 0)).toBeLessThanOrEqual(Math.ceil(KATO / 2));
    }
  });
});

describe('silent path loss (KATO)', () => {
  it('declares a path lost exactly KATO after its last exchange, not before', () => {
    const r = rig();
    r.runTo(10);
    const last = r.init.lastExchange(P0) ?? -1;
    expect(last).toBeGreaterThan(10 - Math.ceil(KATO / 2) - 1);
    r.sim.applyAction({ kind: 'link-down', target: 'l-tgt-p0' });
    r.runTo(last + KATO - 1);
    expect(r.init.pathStates()[P0]).toBe('live');
    expect(r.events('nvme.path.lost')).toHaveLength(0);
    r.sim.tick();
    expect(r.init.pathStates()[P0]).toBe('lost');
    expect(lostAt(r, P0)).toBe(last + KATO);
    expect(r.init.pathStates()[P1]).toBe('live');
    expect(r.init.pathStates()[P20]).toBe('live');
    expect(r.init.health()).toBe('degraded');
  });

  it('holds in-flight commands CQT, then retries them on another path', () => {
    const r = rig();
    r.runTo(10);
    r.sim.applyAction({ kind: 'link-down', target: 'l-tgt-p0' });
    r.runTo(30);
    const lost = lostAt(r, P0) ?? -1;
    const held = r.init.outstanding().held;
    expect(held).toBeGreaterThan(0);
    r.runTo(lost + CQT - 1);
    expect(r.init.outstanding().held).toBe(held);
    r.sim.tick();
    expect(r.init.outstanding().held).toBe(0);
    const retried = r.cvm.completedAt(lost + CQT).filter((c) => c.req.issuedAt <= lost);
    expect(retried.length).toBe(held);
    for (const c of retried) {
      expect(c.outcome.status).toBe('ok');
      expect(lost + CQT - c.req.issuedAt).toBeLessThanOrEqual(KATO + CQT);
    }
    // New IO never waited: everything issued after the loss completed in its own tick.
    const late = r.cvm.done.filter((c) => c.req.issuedAt > lost);
    expect(late.every((c) => c.completedAt === c.req.issuedAt)).toBe(true);
    expect(r.cvm.errors()).toHaveLength(0);
  });

  it('reconnects every reconnectDelayS and restores the path when it answers', () => {
    const r = rig();
    r.runTo(10);
    r.sim.applyAction({ kind: 'link-down', target: 'l-tgt-p0' });
    r.runTo(10 + KATO + 3 * RECONNECT + 1);
    const lost = lostAt(r, P0) ?? -1;
    const attempts = r.events('nvme.path.reconnect').filter((e) => e.text.startsWith(P0));
    expect(attempts.map((e) => e.t)).toEqual([1, 2, 3].map((k) => lost + k * RECONNECT));
    r.sim.applyAction({ kind: 'link-up', target: 'l-tgt-p0' });
    r.runTo(lost + 5 * RECONNECT);
    const restored = r.events('nvme.path.restored').filter((e) => e.text.startsWith(P0));
    expect(restored.map((e) => e.t)).toEqual([lost + 4 * RECONNECT]);
    expect(r.init.pathStates()[P0]).toBe('live');
    expect(r.init.health()).toBe('ok');
  });

  it('deletes the controller after controllerLossTimeoutS', () => {
    const r = rig({ io: { perTick: 1, depth: 2 } });
    r.runTo(10);
    r.sim.applyAction({ kind: 'link-down', target: 'l-tgt-p0' });
    r.runTo(20);
    const lost = lostAt(r, P0) ?? -1;
    r.runTo(lost + CTRL_LOSS - 1);
    expect(r.init.pathStates()[P0]).toBe('lost');
    r.sim.tick();
    expect(r.init.pathStates()[P0]).toBe('removed');
    expect(r.events('nvme.path.removed').map((e) => e.t)).toEqual([lost + CTRL_LOSS]);
    // A deleted controller does not come back by itself (rediscovery is not modeled).
    r.sim.applyAction({ kind: 'link-up', target: 'l-tgt-p0' });
    r.runTo(lost + CTRL_LOSS + 2 * RECONNECT);
    expect(r.init.pathStates()[P0]).toBe('removed');
  });
});

describe('fast path loss (refused)', () => {
  it('loses a path at once when the target closes its endpoint', () => {
    const r = rig();
    r.runTo(10);
    r.tgt.down.add('tgt.ep0');
    r.sim.tick();
    expect(lostAt(r, P0)).toBe(11);
    const ev = r.events('nvme.path.lost')[0];
    expect(ev?.text).toMatch(/refused/);
    expect(ev?.confidence).toBe('inferred');
    // Refused commands are still held CQT before the retry.
    const held = r.init.outstanding().held;
    expect(held).toBeGreaterThan(0);
    r.runTo(11 + CQT);
    expect(r.init.outstanding().held).toBe(0);
  });
});

describe('all paths lost', () => {
  it('queues IO and retries until the array responds', () => {
    const r = rig();
    r.runTo(10);
    r.sim.applyAction({ kind: 'fail', target: 'sw-a' });
    r.sim.applyAction({ kind: 'fail', target: 'sw-b' });
    r.runTo(10 + KATO + 1);
    expect(r.init.health()).toBe('unavailable');
    const all = r.events('nvme.all-paths.lost');
    expect(all).toHaveLength(1);
    r.runTo(80);
    expect(r.cvm.errors()).toHaveLength(0);
    expect(r.cvm.maxPendingS(80)).toBeGreaterThan(60);
    r.sim.applyAction({ kind: 'recover', target: 'sw-a' });
    r.sim.applyAction({ kind: 'recover', target: 'sw-b' });
    r.runTo(80 + RECONNECT + 1);
    expect(r.init.health()).toBe('ok');
    expect(r.cvm.maxPendingS(80 + RECONNECT + 1)).toBeLessThanOrEqual(1);
    expect(r.cvm.errors()).toHaveLength(0);
  });

  it('fails queued IO only once every controller is deleted (profile-driven)', () => {
    const loss = 60;
    const r = rig({
      profile: withEs({ controllerLossTimeoutS: { ...ES.controllerLossTimeoutS, value: loss } }),
    });
    r.runTo(10);
    r.sim.applyAction({ kind: 'fail', target: 'sw-a' });
    r.sim.applyAction({ kind: 'fail', target: 'sw-b' });
    r.runTo(10 + KATO + loss - 1);
    expect(r.cvm.errors()).toHaveLength(0);
    r.runTo(10 + KATO + loss + 2);
    expect(r.events('nvme.all-paths.removed')).toHaveLength(1);
    expect(r.cvm.errors().length).toBeGreaterThan(0);
    expect(r.cvm.pending.size).toBe(0);
  });

  it('never deletes controllers with RECONNECT_FOREVER', () => {
    const r = rig({
      profile: withEs({
        controllerLossTimeoutS: { ...ES.controllerLossTimeoutS, value: RECONNECT_FOREVER },
      }),
      io: { perTick: 1, depth: 1 },
    });
    r.runTo(10);
    r.sim.applyAction({ kind: 'fail', target: 'sw-a' });
    r.sim.applyAction({ kind: 'fail', target: 'sw-b' });
    r.runTo(10 + CTRL_LOSS + 100);
    expect(Object.values(r.init.pathStates()).every((s) => s === 'lost')).toBe(true);
    expect(r.cvm.errors()).toHaveLength(0);
  });
});

describe('IO timeout on a live but broken queue', () => {
  it('aborts and retries IO stuck behind a hung LACP member (slow rate)', () => {
    // Periodic OVS rebalancing would move the blackholed buckets off the hung member by load;
    // switch it off to isolate the initiator's IO timeout.
    const r = rig({
      fabric: {
        mode: 'balance-tcp',
        mlag: true,
        lacpRate: 'slow',
        config: { slbRebalanceIntervalS: 100_000 },
      },
    });
    r.runTo(10);
    r.sim.applyAction({ kind: 'hang', target: 'l-h1-eth0' });
    r.runTo(10 + IO_TIMEOUT + 3);
    const timeouts = r.events('nvme.io.timeout');
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts[0]?.t).toBe(11 + IO_TIMEOUT);
    // Some path stayed live (admin queue on the good member) while its IO queues hung.
    expect(Object.values(r.init.pathStates())).toContain('live');
    r.runTo(10 + 90 + RECONNECT + KATO);
    expect(r.cvm.errors()).toHaveLength(0);
    expect(r.cvm.maxPendingS(r.sim.getSnapshot().simTime)).toBeLessThanOrEqual(1);
  });
});

describe('multipath policy', () => {
  it('active-active round-robins a vDisk over every live path', () => {
    const r = rig();
    r.runTo(5);
    expect(r.init.pathsFor(StubCvm.vdisk('vm1'))).toEqual([P0, P1, P20].sort());
  });

  it('active-passive keeps one sticky path and fails over on loss', () => {
    const r = rig({ policy: 'active-passive', io: { depth: 1000 } });
    r.runTo(5);
    const used = r.init.pathsFor(StubCvm.vdisk('vm1'));
    expect(used).toHaveLength(1);
    const first = used[0] ?? '';
    const link = first.endsWith('tgt.ep0') ? 'l-tgt-p0' : 'l-tgt-p1';
    r.sim.applyAction({ kind: 'link-down', target: link });
    r.runTo(5 + KATO + 2);
    const next = r.init.pathsFor(StubCvm.vdisk('vm1'));
    expect(next).toHaveLength(1);
    expect(next[0]).not.toBe(first);
    r.runTo(5 + KATO + 8);
    expect(r.init.pathsFor(StubCvm.vdisk('vm1'))).toEqual(next);
  });
});

describe('CVM restart', () => {
  it('drops outstanding IO on failure and reconnects every path on recovery', () => {
    const r = rig();
    r.runTo(10);
    r.sim.applyAction({ kind: 'fail', target: 'h1.cvm' });
    r.runTo(20);
    r.sim.applyAction({ kind: 'recover', target: 'h1.cvm' });
    r.sim.tick();
    expect(r.init.health()).toBe('ok');
    expect(r.events('nvme.path.lost')).toHaveLength(0);
    expect(r.events('nvme.path.restored')).toHaveLength(3);
  });
});
