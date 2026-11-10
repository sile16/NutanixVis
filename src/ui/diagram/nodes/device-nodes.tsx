import type { NodeProps } from '@xyflow/react';
import { clsx } from 'clsx';
import {
  Box,
  Cpu,
  Database,
  EthernetPort,
  HardDrive,
  History,
  MoveRight,
  Network,
  Route,
  Server,
  SquareStack,
  Waypoints,
} from 'lucide-react';
import { EverpureMark } from '../../components/brand';
import { StatusIcon, StatusPill } from '../../components/status';
import type { DeviceNode } from '../flow';
import { movedBy, movedTitle } from '../vm-placement';
/**
 * Custom React Flow node types (SPEC §8): switch, AHV host (group), CVM, VM, FlashArray (group)
 * → controller (group) → port / interface, NIC, vswitch, disk. Each reads only `data.device`
 * (a `DeviceView`) plus layout-provided ports.
 */
import { LineBars, ShareBars } from './meter-bars';
import {
  Badges,
  BOND_MODE_LABEL,
  BOND_MODE_SHORT,
  frameStyle,
  GroupFrame,
  LeafCard,
  NOTE_TONE,
  NoteLine,
  nodeAttrs,
  Ports,
} from './parts';

type P = NodeProps<DeviceNode>;

export function SwitchNode({ data, selected }: P) {
  const { device } = data;
  const vlans = device.fields.vlans;
  return (
    <div
      className="nv-node relative flex h-full w-full items-center gap-2 rounded-lg bg-panel px-3 shadow-sm"
      style={frameStyle(device)}
      {...nodeAttrs(data, selected)}
    >
      <Network size={18} className="text-ink-muted" aria-hidden="true" />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-semibold">{device.label}</span>
        {typeof vlans === 'string' ? (
          <span className="truncate text-[10px] text-ink-muted">VLANs {vlans}</span>
        ) : null}
      </div>
      <StatusPill status={device.status} />
      <span className="ml-auto">
        <Badges badges={device.badges} />
      </span>
      <Ports ports={data.ports} />
    </div>
  );
}

export function HostNode({ data, selected }: P) {
  const role = data.device.fields.role;
  const subtitle =
    role === 'external-storage-compute'
      ? 'AHV · compute'
      : role === 'hci'
        ? 'AHV · HCI'
        : role === 'compute-only'
          ? 'AHV · compute-only'
          : role === 'storage-only'
            ? 'AHV · storage-only'
            : 'AHV';
  return (
    <GroupFrame
      data={data}
      selected={selected}
      Icon={Server}
      title={data.device.label}
      subtitle={subtitle}
      tone="strong"
    />
  );
}

/** Cards narrower than this show role badges as icons only (label in the tooltip). */
const NARROW = 140;

/** A running CVM whose Cassandra ring state is not normal gets a badge for it. */
function withRingBadge(data: P['data']): P['data'] {
  const ring = data.device.fields.ringState;
  const running = data.device.status !== 'failed' && data.device.status !== 'offline';
  if (!running || (ring !== 'down' && ring !== 'detached' && ring !== 'forwarding')) return data;
  return { ...data, device: { ...data.device, badges: [...data.device.badges, `ring-${ring}`] } };
}

export function CvmNode({ data: raw, selected, width }: P) {
  const narrow = (width ?? 0) < NARROW;
  const data = withRingBadge(raw);
  if (data.isGroup) {
    return (
      <GroupFrame
        data={data}
        selected={selected}
        Icon={Cpu}
        title={data.device.label}
        iconBadges={narrow}
      />
    );
  }
  return (
    <LeafCard data={data} selected={selected} Icon={Cpu}>
      <span className="shrink-0 text-[11px] font-semibold">{data.device.label}</span>
      <Badges badges={data.device.badges} compact iconOnly={narrow} />
    </LeafCard>
  );
}

export function VmNode({ data, selected }: P) {
  // A partial stall: the VM runs, but some of its IO is stuck (for example on a silently dead path).
  const stuck = data.device.fields.stuckIoPct;
  const partial =
    data.device.fields.state === 'running' && typeof stuck === 'number' && stuck > 0 && stuck < 100
      ? stuck
      : null;
  return (
    <LeafCard data={data} selected={selected} Icon={Box}>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[11px] font-medium">{data.device.label}</span>
        {partial !== null ? (
          <span
            className="truncate text-[8px] font-medium text-status-stalled"
            data-testid={`vm-partial-${data.device.id}`}
            title={`${partial}% of this VM's queued IO is stuck; the rest completes`}
          >
            {partial}% of IO stalled
          </span>
        ) : null}
        {data.movedFrom ? (
          <span
            className="flex items-center gap-0.5 truncate text-[8px] text-accent-ink"
            data-testid={`restart-marker-${data.device.id}`}
            data-moved-by={movedBy(data.device)}
            title={movedTitle(movedBy(data.device), data.movedFrom)}
          >
            {movedBy(data.device) === 'live-migration' ? (
              <MoveRight size={8} aria-hidden="true" className="shrink-0" />
            ) : (
              <History size={8} aria-hidden="true" className="shrink-0" />
            )}
            from {data.movedFrom}
          </span>
        ) : null}
      </span>
    </LeafCard>
  );
}

export function ArrayNode({ data, selected }: P) {
  return (
    <GroupFrame
      data={data}
      selected={selected}
      Icon={Database}
      logo={<EverpureMark size={data.frame.header > 24 ? 16 : 13} />}
      title={
        data.device.label.startsWith('FlashArray')
          ? `Everpure ${data.device.label}`
          : 'Everpure FlashArray'
      }
      {...(data.device.label.startsWith('FlashArray') ? {} : { subtitle: data.device.label })}
      tone="strong"
    />
  );
}

export function ControllerNode({ data, selected }: P) {
  // Mid-promotion no controller holds the primary badge; say which one is taking over.
  const promoting = data.device.fields.role === 'promoting';
  const shown = promoting
    ? { ...data, device: { ...data.device, badges: [...data.device.badges, 'fa-promoting'] } }
    : data;
  return <GroupFrame data={shown} selected={selected} Icon={HardDrive} title={data.device.label} />;
}

export function NicNode({ data, selected }: P) {
  if (data.isGroup) {
    // An array port frame holds its interface: the line-rate bars sit on the frame's bottom edge.
    return (
      <GroupFrame data={data} selected={selected} Icon={EthernetPort} title={data.device.label}>
        {data.meter?.kind === 'line' ? (
          <LineBars
            meter={data.meter.line}
            row
            className="absolute inset-x-1.5 -bottom-1 rounded bg-panel px-0.5"
          />
        ) : null}
      </GroupFrame>
    );
  }
  return (
    <LeafCard
      data={data}
      selected={selected}
      className={clsx('relative justify-center px-1', data.meter?.kind === 'line' && 'pb-2.5')}
    >
      <span className="flex min-w-0 flex-col items-center leading-tight">
        <span className="truncate font-mono text-[10px] font-medium">{data.device.label}</span>
        <NoteLine note={data.note} />
      </span>
      {data.utilLabel ? (
        <span className="rounded bg-accent/15 px-0.5 font-mono text-[9px] text-accent-ink">
          {data.utilLabel}
        </span>
      ) : null}
      {data.meter?.kind === 'line' ? (
        <LineBars meter={data.meter.line} className="absolute inset-x-1 bottom-0.5" />
      ) : null}
    </LeafCard>
  );
}

/** Interfaces at least this wide also show their IP inline (narrower ones: tooltip only). */
const IP_INLINE = 110;

export function IfaceNode({ data, selected, width }: P) {
  const { device } = data;
  const vlan = device.fields.vlan;
  const ip = typeof device.fields.ip === 'string' ? device.fields.ip : null;
  // The label alone ("VLAN 10", "mgmt") must stay readable on a narrow port; the IP fits only on
  // wide boxes such as the relocated VIP, and is always in the tooltip and the inspector.
  const showIp = ip !== null && device.kind === 'fa-interface' && (width ?? 0) >= IP_INLINE;
  const attrs = nodeAttrs(data, selected);
  return (
    <div
      className="nv-node relative flex h-full w-full items-center gap-1 overflow-hidden rounded bg-panel-2 px-1"
      style={frameStyle(device)}
      {...attrs}
      title={[attrs.title, ip, data.note?.text].filter(Boolean).join(' · ')}
    >
      <span
        className={clsx('truncate font-mono', (width ?? 100) < 70 ? 'text-[8px]' : 'text-[9px]')}
      >
        {device.label}
        {showIp ? <span className="text-ink-muted"> {ip}</span> : null}
        {data.note ? (
          <span className={clsx('ml-1 font-sans', NOTE_TONE[data.note.tone])}>
            {data.note.text}
          </span>
        ) : null}
      </span>
      {typeof vlan === 'number' && device.kind === 'cvm-interface' ? (
        <span className="sr-only">VLAN {vlan}</span>
      ) : null}
      <span className="ml-auto">
        <StatusIcon status={device.status} size={10} />
      </span>
      <Ports ports={data.ports} />
    </div>
  );
}

export function VswitchNode({ data, selected, width }: P) {
  const mode = String(data.device.fields.bondMode ?? '');
  const full = BOND_MODE_LABEL[mode] ?? mode;
  // Single-NIC hosts get a narrow vswitch card: the short mode name still fits.
  const label = (width ?? 200) < 110 ? (BOND_MODE_SHORT[mode] ?? full) : full;
  return (
    <LeafCard
      data={data}
      selected={selected}
      className={clsx('relative bg-panel-2', data.meter?.kind === 'share' && 'pb-3')}
    >
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[10px]" title={`${data.device.label} · ${full}`}>
          <span className="font-semibold">{data.device.label}</span>
          <span className="text-ink-muted"> · {label}</span>
        </span>
        <NoteLine note={data.note} />
      </span>
      {data.meter?.kind === 'share' ? (
        <ShareBars
          slices={data.meter.slices}
          what={`${data.device.label} distribution`}
          className="absolute inset-x-1.5 bottom-0.5"
        />
      ) : null}
    </LeafCard>
  );
}

/** "NVMe 1" → ["NVMe", "1"], so a 28 px disk card can stack media over number. */
export function splitDiskLabel(label: string): [string, string] {
  const m = /^(.*?)\s*(\d+)$/.exec(label.trim());
  return m ? [m[1] || label, m[2] ?? ''] : [label, ''];
}

export function DiskNode({ data, selected }: P) {
  const { device } = data;
  const [media, num] = splitDiskLabel(device.label);
  return (
    <div
      className="nv-node relative flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-md bg-panel leading-none text-ink shadow-sm"
      style={frameStyle(device)}
      {...nodeAttrs(data, selected)}
    >
      <span className="font-mono text-[7px] text-ink-muted">{media}</span>
      <span className="flex items-center gap-0.5 font-mono text-[9px] font-medium">
        {num}
        <StatusIcon status={device.status} size={9} />
      </span>
      <Ports ports={data.ports} />
    </div>
  );
}

/** Stargate, drawn inside its CVM: the process that serves the vDisks and speaks NVMe/TCP. */
export function StargateNode({ data, selected }: P) {
  return (
    <LeafCard data={data} selected={selected} Icon={Waypoints} className="relative justify-start">
      <span className="shrink-0 truncate text-[10px] font-semibold">
        Stargate
        {data.device.fields.state !== 'up' ? (
          <span className="font-mono font-normal text-ink-muted">
            {' '}
            · {String(data.device.fields.state)}
          </span>
        ) : null}
      </span>
      {data.meter?.kind === 'share' ? (
        <ShareBars
          slices={data.meter.slices}
          what="Stargate distribution over its storage interfaces"
          inline
          shortLabel={(l) => l.replace(/^CVM-IP\s+/i, '')}
          className="ml-2"
        />
      ) : null}
    </LeafCard>
  );
}

/** The AHV IO redirector (frodo) between the VMs and the CVM. */
export function RedirectorNode({ data, selected }: P) {
  return (
    <LeafCard data={data} selected={selected} Icon={Route} className="justify-center">
      <span className="truncate text-[10px] font-medium">frodo · IO redirector</span>
    </LeafCard>
  );
}

/** Empty VM area of a node that runs no VMs: keeps its CVM aligned with the other nodes. */
export function VmSpacerNode({ data }: P) {
  return (
    <div
      className="flex size-full items-center justify-center rounded-md border border-dashed border-border text-[10px] text-ink-muted"
      data-testid={`node-${data.device.id}`}
      role="img"
      aria-label="no VMs on this node"
    >
      no VMs
    </div>
  );
}

export function GenericNode({ data, selected }: P) {
  if (data.isGroup) {
    return (
      <GroupFrame data={data} selected={selected} Icon={SquareStack} title={data.device.label} />
    );
  }
  return <LeafCard data={data} selected={selected} />;
}
