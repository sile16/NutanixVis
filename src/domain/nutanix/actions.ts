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
          isKind(t, 'cvm') && field(t, 'power') === 'running' && field(t, 'stargate') === 'down',
      },
      apply: (req) => cvm(req.target).requestStargate('start'),
    },
    {
      spec: {
        kind: 'cvm.crash-stargate',
        label: 'Crash Stargate',
        description:
          'The Stargate process exits on a running CVM: its connections are reset, so VMs log in elsewhere at once; its self-monitor restarts it within seconds.',
        appliesTo: (t) =>
          isKind(t, 'cvm') && field(t, 'power') === 'running' && field(t, 'stargate') !== 'down',
      },
      apply: (req, ctx) => {
        reg.causes.set(req.target, ctx.causeIds);
        cvm(req.target).requestStargate('crash');
      },
    },
    {
      spec: {
        kind: 'cvm.hang-stargate',
        label: 'Hang Stargate',
        description:
          'The Stargate process stays alive but stops answering IO and NOPs, with its connections open: initiators notice only by their NOPs, and peers take its vDisks only once its Zookeeper session expires.',
        appliesTo: (t) =>
          isKind(t, 'cvm') &&
          field(t, 'power') === 'running' &&
          (field(t, 'stargate') === 'up' || field(t, 'stargate') === 'unhealthy'),
      },
      apply: (req, ctx) => {
        reg.causes.set(req.target, ctx.causeIds);
        cvm(req.target).requestStargate('hang');
      },
    },
    {
      spec: {
        kind: 'cvm.resume-stargate',
        label: 'Resume hung Stargate',
        description:
          'The hung process runs again; its watchdog fires, so it exits and its self-monitor restarts it.',
        appliesTo: (t) => isKind(t, 'cvm') && field(t, 'stargate') === 'hung',
      },
      apply: (req) => cvm(req.target).requestStargate('resume'),
    },
    {
      spec: {
        kind: 'cvm.network-flap',
        label: 'Flap / isolate CVM network (peer blackout)',
        description:
          'The CVM’s inter-CVM interface stops answering, then returns; its host-internal link and storage paths stay up. A short flap leaves a partly unresponsive node that Degraded Node Detection may mark Degraded. A blackout as long as the Zookeeper session timeout makes its Stargate drop out, so its VMs’ IO moves to other Stargates; a node that stays unreachable is treated as dead, not Degraded.',
        appliesTo: (t) => isKind(t, 'cvm') && field(t, 'power') === 'running',
        params: { durationS: { label: 'Blackout (s)', choices: [5, 10, 15, 60, 120] } },
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
        kind: 'cvm.network-loss',
        label: 'Lossy CVM network (partial unresponsiveness)',
        description:
          'Packet loss on the CVM’s inter-CVM interface; it keeps running and its storage paths stay up. Light loss only makes its peers score it as an outlier. Heavy loss leaves it half reachable: its Stargate drops out when its Zookeeper session expires, but it keeps its metadata role, so its peers’ Stargate operations hang and fail fast in a wave across the cluster until Degraded Node Detection marks it Degraded. 0 % clears it.',
        appliesTo: (t) => isKind(t, 'cvm') && field(t, 'power') === 'running',
        params: { pct: { label: 'Loss (%)', choices: [0, 10, 30, 50, 80] } },
      },
      apply: (req, ctx) => {
        const n = Number(req.params?.pct);
        if (!Number.isFinite(n) || n < 0 || n > 100) throw new ActionError(`bad loss ${String(n)}`);
        reg.causes.set(req.target, ctx.causeIds);
        cvm(req.target).requestNetworkLoss(n);
      },
    },
    {
      spec: {
        kind: 'cvm.internal-link-down',
        label: 'Fail host–CVM internal link',
        description:
          'The internal link between the AHV host and its CVM fails; the CVM’s cluster network and storage paths stay up. The host’s VM initiators miss their NOPs and log in again through the redirector; a peer Stargate sends each session on to this CVM’s external portal while it is alive, so the same Stargate keeps serving after about one NOP detection, with no vDisk handover.',
        appliesTo: (t) =>
          isKind(t, 'cvm') && field(t, 'power') !== 'off' && field(t, 'internalLink') !== 'down',
      },
      apply: (req, ctx) => {
        reg.causes.set(req.target, ctx.causeIds);
        cvm(req.target).requestInternalLink(false);
      },
    },
    {
      spec: {
        kind: 'cvm.internal-link-up',
        label: 'Restore host–CVM internal link',
        description:
          'The internal link returns. Sessions already on the CVM’s external portal stay there for a long validity window, then move back.',
        appliesTo: (t) => isKind(t, 'cvm') && field(t, 'internalLink') === 'down',
      },
      apply: (req) => cvm(req.target).requestInternalLink(true),
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
