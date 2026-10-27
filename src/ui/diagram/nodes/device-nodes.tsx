/**
 * Custom React Flow node types (SPEC §8): switch, AHV host (group), CVM, VM, FlashArray (group)
 * → controller (group) → port / interface, NIC, vswitch, disk. Each reads only `data.device`
 * (a `DeviceView`) plus layout-provided ports.
 */
import type { NodeProps } from '@xyflow/react';
import { clsx } from 'clsx';
import {
  Box,
  Cpu,
  Database,
  EthernetPort,
  HardDrive,
  History,
  Network,
  Server,
  SquareStack,
} from 'lucide-react';
import { EverpureMark } from '../../components/brand';
import { StatusIcon, StatusPill } from '../../components/status';
import type { DeviceNode } from '../flow';
import {
  Badges,
  BOND_MODE_LABEL,
  BOND_MODE_SHORT,
  frameStyle,
  GroupFrame,
  LeafCard,
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
    role === 'external-storage-compute' ? 'AHV · compute' : role === 'hci' ? 'AHV · HCI' : 'AHV';
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

export function CvmNode({ data, selected, width }: P) {
  const narrow = (width ?? 0) < NARROW;
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
  return (
    <LeafCard data={data} selected={selected} Icon={Box}>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[11px] font-medium">{data.device.label}</span>
        {data.restartedFrom ? (
          <span
            className="flex items-center gap-0.5 truncate text-[8px] text-accent-ink"
            data-testid={`restart-marker-${data.device.id}`}
            title={`AHV HA restarted this VM here from ${data.restartedFrom}`}
          >
            <History size={8} aria-hidden="true" className="shrink-0" />
            from {data.restartedFrom}
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
    return (
      <GroupFrame data={data} selected={selected} Icon={EthernetPort} title={data.device.label} />
    );
  }
  return (
    <LeafCard data={data} selected={selected} className="justify-center px-1">
      <span className="truncate font-mono text-[10px] font-medium">{data.device.label}</span>
      {data.utilLabel ? (
        <span className="rounded bg-accent/15 px-0.5 font-mono text-[9px] text-accent-ink">
          {data.utilLabel}
        </span>
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
      title={ip ? `${attrs.title} · ${ip}` : attrs.title}
    >
      <span
        className={clsx('truncate font-mono', (width ?? 100) < 70 ? 'text-[8px]' : 'text-[9px]')}
      >
        {device.label}
        {showIp ? <span className="text-ink-muted"> {ip}</span> : null}
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
    <LeafCard data={data} selected={selected} className="bg-panel-2">
      <span className="truncate text-[10px]" title={`${data.device.label} · ${full}`}>
        <span className="font-semibold">{data.device.label}</span>
        <span className="text-ink-muted"> · {label}</span>
      </span>
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

export function GenericNode({ data, selected }: P) {
  if (data.isGroup) {
    return (
      <GroupFrame data={data} selected={selected} Icon={SquareStack} title={data.device.label} />
    );
  }
  return <LeafCard data={data} selected={selected} />;
}
