/**
 * Nutanix / workload actions (SPEC §5.5). `power-off` / `power-on` on a host or CVM are the
 * engine's hard fail / recover (so the generic `recover` also powers them back on); `reboot` is a
 * power cycle the domain times itself. Irrelevant targets are filtered out by `appliesTo`.
 */

import type { ActionTarget } from '../../engine/actions';
import { type ActionDefinition, ActionError, isLinkView, stringParam } from '../../engine/actions';
import type { DeviceView } from '../../engine/types';
import type { Registry } from './registry';

const isKind = (t: ActionTarget, ...kinds: string[]): t is DeviceView =>
  !isLinkView(t) && kinds.includes(t.kind);
const field = (t: DeviceView, k: string) => t.fields[k];

export const FORCE_SHUTDOWN_CHOICES = ['off', 60, 120, 300] as const;

export function nutanixActions(reg: Registry): ActionDefinition[] {
  const host = (id: string) => {
    const h = reg.hosts.get(id);
    if (!h) throw new ActionError(`${id} is not an AHV host`);
    return h;
  };
  const cvm = (id: string) => {
    const c = reg.cvms.get(id);
    if (!c) throw new ActionError(`${id} is not a CVM`);
    return c;
  };
  const vm = (id: string) => {
    const v = reg.vms.get(id);
    if (!v) throw new ActionError(`${id} is not a VM`);
    return v;
  };

  return [
    {
      spec: {
        kind: 'power-off',
        label: 'Power off',
        description: 'Host or CVM: hard power off. VM: guest powered off (no HA restart).',
        appliesTo: (t) =>
          (isKind(t, 'ahv-host', 'cvm') && t.status !== 'failed') ||
          (isKind(t, 'vm') && field(t, 'state') !== 'off'),
      },
      apply: (req, ctx) => {
        reg.causes.set(req.target, ctx.causeIds);
        if (reg.vms.has(req.target)) vm(req.target).powerOff();
        else ctx.failDevice(req.target);
      },
    },
    {
      spec: {
        kind: 'power-on',
        label: 'Power on',
        appliesTo: (t) =>
          (isKind(t, 'ahv-host', 'cvm') && t.status === 'failed') ||
          (isKind(t, 'vm') && field(t, 'state') === 'off'),
      },
      apply: (req, ctx) => {
        reg.causes.set(req.target, ctx.causeIds);
        if (reg.vms.has(req.target)) reg.powerOnRequests.add(vm(req.target).id);
        else ctx.recoverDevice(req.target);
      },
    },
    {
      spec: {
        kind: 'reboot',
        label: 'Reboot',
        description:
          'Host: power cycle (VMs die and AHV HA restarts them). CVM: restart, Stargate is back after the CVM boot time.',
        appliesTo: (t) =>
          isKind(t, 'ahv-host', 'cvm') && t.status !== 'failed' && t.status !== 'offline',
      },
      apply: (req, ctx) => {
        reg.causes.set(req.target, ctx.causeIds);
        if (reg.hosts.has(req.target)) host(req.target).requestReboot();
        else cvm(req.target).requestReboot();
      },
    },
    {
      spec: {
        kind: 'host.isolate',
        label: 'Isolate host (all uplinks down)',
        description: 'Every cable of the host loses carrier; the host and its VMs keep running.',
        appliesTo: (t) => isKind(t, 'ahv-host') && field(t, 'isolated') !== true,
      },
      apply: (req, ctx) => {
        const h = host(req.target);
        const down = h.facts.nicLinks.filter((l) => ctx.net.isAdminUp(l));
        for (const l of down) ctx.net.setLinkUp(l, false);
        h.isolatedLinks = down;
      },
    },
    {
      spec: {
        kind: 'host.unisolate',
        label: 'Reconnect host',
        appliesTo: (t) => isKind(t, 'ahv-host') && field(t, 'isolated') === true,
      },
      apply: (req, ctx) => {
        const h = host(req.target);
        for (const l of h.isolatedLinks) ctx.net.setLinkUp(l, true);
        h.isolatedLinks = [];
      },
    },
    {
      spec: {
        kind: 'cvm.stop-stargate',
        label: 'Stop Stargate',
        description: 'The Stargate process stops; the CVM stays up.',
        appliesTo: (t) => isKind(t, 'cvm') && field(t, 'stargate') !== 'down',
      },
      apply: (req, ctx) => {
        reg.causes.set(req.target, ctx.causeIds);
        cvm(req.target).requestStargate('stop');
      },
    },
    {
      spec: {
        kind: 'cvm.start-stargate',
        label: 'Start Stargate',
        appliesTo: (t) =>
          isKind(t, 'cvm') && field(t, 'power') === 'running' && field(t, 'stargate') !== 'up',
      },
      apply: (req) => cvm(req.target).requestStargate('start'),
    },
    {
      spec: {
        kind: 'cvm.network-flap',
        label: 'Flap CVM network (peer blackout)',
        description:
          'The CVM’s inter-CVM interface stops answering for a short time, then returns: a flapping or partly unresponsive node. Degraded Node Detection may mark it Degraded.',
        appliesTo: (t) => isKind(t, 'cvm') && field(t, 'power') === 'running',
        params: { durationS: { label: 'Blackout (s)', choices: [5, 10, 15] } },
      },
      apply: (req, ctx) => {
        const n = Number(req.params?.durationS);
        if (!Number.isFinite(n) || n < 1) throw new ActionError(`bad duration ${String(n)}`);
        reg.causes.set(req.target, ctx.causeIds);
        cvm(req.target).requestNetworkFlap(n);
      },
    },
    {
      spec: {
        kind: 'cvm.mark-fixed',
        label: 'Mark node fixed (clear Degraded)',
        description:
          'Operator action after fixing a node that Degraded Node Detection flagged: its metadata store rejoins at once instead of after the long healthy observation period.',
        appliesTo: (t) => isKind(t, 'cvm') && field(t, 'dndState') === 'degraded',
      },
      apply: (req) => {
        cvm(req.target);
        reg.dndMarkFixed.add(req.target);
      },
    },
    {
      spec: {
        kind: 'vm.set-path-loss-force-shutdown',
        label: 'Set path-loss force-shutdown timeout',
        description:
          'Per-VM option (DEPLOY-GUIDE): off = retry IO until the array responds; otherwise power the VM off after this long without storage paths and restart it on a node with array connectivity.',
        appliesTo: (t) => isKind(t, 'vm') && reg.facts.externalStorage,
        params: { seconds: { label: 'Timeout (s)', choices: FORCE_SHUTDOWN_CHOICES } },
      },
      apply: (req) => {
        const raw = req.params?.seconds;
        const v = typeof raw === 'number' ? raw : stringParam(req, 'seconds');
        if (v === 'off') return vm(req.target).setPathLossForceShutdownS(null);
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) throw new ActionError(`bad timeout ${String(v)}`);
        vm(req.target).setPathLossForceShutdownS(n);
      },
    },
    {
      spec: {
        kind: 'vm.pause',
        label: 'Pause VM',
        appliesTo: (t) =>
          isKind(t, 'vm') && field(t, 'host') !== null && field(t, 'state') !== 'paused',
      },
      apply: (req) => vm(req.target).pause(true),
    },
    {
      spec: {
        kind: 'vm.resume',
        label: 'Resume VM',
        appliesTo: (t) => isKind(t, 'vm') && field(t, 'state') === 'paused',
      },
      apply: (req) => vm(req.target).pause(false),
    },
  ];
}
