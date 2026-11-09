import { describe, expect, it } from 'vitest';
import { current } from '../../../src/domain/versions/profiles/current';
import type { Snapshot } from '../../../src/engine/types';
import { loadSimulation } from '../../../src/loader/simulation';

const maxPending = (s: Snapshot): number =>
  Math.max(
    0,
    ...Object.values(s.devices).flatMap((d) =>
      d.kind === 'vm' && typeof d.fields.ioPendingS === 'number' ? [d.fields.ioPendingS] : [],
    ),
  );

describe('planned CVM shutdown', () => {
  it('HCI: peers learn of the orderly stop at once, so no write waits for crash detection', () => {
    const sim = loadSimulation({ topologyId: 't2-hci-ahv', options: {}, seed: 1 }).sim;
    sim.tick(20);
    sim.applyAction({ kind: 'cvm.planned-shutdown', target: 'node-2.cvm' });
    let worst = 0;
    for (let i = 0; i < 120; i++) worst = Math.max(worst, maxPending(sim.tick(1)));
    const off = sim.eventLog().some((e) => e.code === 'cvm.planned-shutdown.off');
    expect(off).toBe(true);
    // A crash would stall writes with a replica on that node until the ZK session expires.
    const crashDetect = current.hci.stargateDownDetectS.value;
    expect(worst).toBeLessThan(crashDetect / 4);
  });

  it('T1: a CVM off longer than the remount delay keeps its service-volume seat', () => {
    const sim = loadSimulation({ topologyId: 't1-ahv-flasharray', options: {}, seed: 1 }).sim;
    sim.tick(20);
    sim.applyAction({ kind: 'cvm.planned-shutdown', target: 'node-2.cvm' });
    sim.tick(600);
    expect(sim.eventLog().some((e) => e.code === 'zk.seat.migrated')).toBe(false);
  });
});
