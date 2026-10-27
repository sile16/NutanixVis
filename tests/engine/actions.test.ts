import { describe, expect, it } from 'vitest';
import { type ActionDefinition, ActionError, ActionRegistry, numberParam } from '../../src/engine';
import { fabric, probeSim } from './helpers';

const kinds = (specs: readonly { kind: string }[]) => specs.map((s) => s.kind);

describe('action registry', () => {
  it('offers only applicable actions per target and state', () => {
    const s = probeSim(fabric(), []);
    expect(kinds(s.availableActions('sw-a'))).toEqual(['fail', 'hang', 'fabric.set-mlag']);
    expect(kinds(s.availableActions('l-isl'))).toEqual([
      'link-down',
      'hang',
      'set-latency',
      'switch.port.prune-vlan',
    ]);
    expect(kinds(s.availableActions('h1'))).toEqual(['fail']);
    expect(kinds(s.availableActions('h1.vs1'))).toEqual([
      'vswitch.set-bond-mode',
      'vswitch.set-uplinks',
      'vswitch.set-lacp-rate',
      'vswitch.set-slb-vlan-aware',
    ]);
    expect(s.availableActions('nope')).toEqual([]);

    s.applyAction({ kind: 'fail', target: 'sw-a' });
    s.applyAction({ kind: 'link-down', target: 'l-isl' });
    s.applyAction({ kind: 'switch.port.prune-vlan', target: 'l-isl', params: { vlan: 20 } });
    s.tick();
    expect(kinds(s.availableActions('sw-a'))).toEqual(['recover', 'hang', 'fabric.set-mlag']);
    expect(kinds(s.availableActions('l-isl'))).toEqual([
      'link-up',
      'hang',
      'set-latency',
      'switch.port.prune-vlan',
      'switch.port.allow-vlan',
    ]);
  });

  it('describes parameter choices for the UI', () => {
    const s = probeSim(fabric(), []);
    const mode = s.availableActions('h1.vs1').find((a) => a.kind === 'vswitch.set-bond-mode');
    expect(mode?.params?.mode?.choices).toEqual([
      'active-backup',
      'balance-slb',
      'balance-tcp',
      'no-bond',
    ]);
    const prune = s.availableActions('l-isl').find((a) => a.kind === 'switch.port.prune-vlan');
    expect(prune?.params?.vlan?.choices).toEqual([1, 10, 20]);
  });

  it('logs rejected actions instead of applying them', () => {
    const s = probeSim(fabric(), []);
    s.applyAction({ kind: 'no-such-action', target: 'sw-a' });
    s.applyAction({ kind: 'fail', target: 'ghost' });
    s.applyAction({ kind: 'link-down', target: 'sw-a' });
    s.applyAction({ kind: 'set-latency', target: 'l-isl', params: { ms: 'fast' } });
    s.applyAction({ kind: 'vswitch.set-bond-mode', target: 'h1.vs1', params: { mode: 'lacp' } });
    const snap = s.tick();
    expect(snap.events.map((e) => [e.code, e.text.split(': ').at(-1)])).toEqual([
      ['action.rejected', 'unknown action'],
      ['action.rejected', 'unknown target'],
      ['action.rejected', 'not applicable to this target'],
      ['action.set-latency', 'l-isl (ms=fast)'],
      ['action.rejected', "param 'ms' must be a number"],
      ['action.vswitch.set-bond-mode', 'h1.vs1 (mode=lacp)'],
      ['action.rejected', "'lacp' is not one of active-backup, balance-slb, balance-tcp, no-bond"],
    ]);
    expect(snap.devices['h1.vs1']?.fields.mode).toBe('active-backup');
  });

  it('applies queued actions in order at the start of the next tick', () => {
    const s = probeSim(fabric(), []);
    s.applyAction({ kind: 'fail', target: 'sw-a' });
    s.applyAction({ kind: 'recover', target: 'sw-a' });
    expect(s.queuedActions()).toHaveLength(2);
    const snap = s.tick();
    expect(s.queuedActions()).toEqual([]);
    expect(snap.devices['sw-a']?.status).toBe('healthy');
    expect(snap.events.map((e) => e.code)).toContain('device.recovered');
  });

  it('accepts domain-registered actions and rejects duplicates', () => {
    let applied = 0;
    const custom: ActionDefinition = {
      spec: {
        kind: 'test.bump',
        label: 'Bump',
        appliesTo: (t) => t.id === 'tgt',
        params: { by: { label: 'By', choices: [1, 2] } },
      },
      apply: (req, ctx) => {
        applied += numberParam(req, 'by');
        if (applied > 2) throw new ActionError('too much');
        ctx.emit({
          severity: 'info',
          code: 'test.bumped',
          text: 'bumped',
          causeIds: ctx.causeIds,
          cite: [],
        });
      },
    };
    const s = probeSim(fabric(), [], { actions: [custom] });
    expect(kinds(s.availableActions('tgt'))).toContain('test.bump');
    expect(kinds(s.availableActions('h1'))).not.toContain('test.bump');
    s.applyAction({ kind: 'test.bump', target: 'tgt', params: { by: 2 } });
    s.applyAction({ kind: 'test.bump', target: 'tgt', params: { by: 1 } });
    const ev = s.tick().events;
    expect(ev.map((e) => e.code)).toEqual([
      'action.test.bump',
      'test.bumped',
      'action.test.bump',
      'action.rejected',
    ]);
    expect(ev[1]?.causeIds).toEqual([`e${ev[0]?.seq}`]);
    expect(() => new ActionRegistry([custom, custom])).toThrow(/already registered/);
  });
});
