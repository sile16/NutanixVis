/**
 * Custom React Flow node types (SPEC §8): switch, AHV host (group), CVM, VM, FlashArray (group)
 * → controller (group) → port / interface, NIC, vswitch, disk. Each reads only `data.device`
 * (a `DeviceView`) plus layout-provided ports.
 */
import type { NodeProps } from '@xyflow/react';
import {
  Box,
  Cpu,
  Database,
  EthernetPort,
  HardDrive,
  Network,
  Server,
  SquareStack,
} from 'lucide-react';
import { StatusIcon, StatusPill } from '../../components/status';
import type { DeviceNode } from '../flow';
import {
  Badges,
  BOND_MODE_LABEL,
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

export function CvmNode({ data, selected }: P) {
  if (data.isGroup) {
    return <GroupFrame data={data} selected={selected} Icon={Cpu} title={data.device.label} />;
  }
  return (
    <LeafCard data={data} selected={selected} Icon={Cpu}>
      <span className="shrink-0 text-[11px] font-semibold">{data.device.label}</span>
      <Badges badges={data.device.badges} compact />
    </LeafCard>
  );
}

export function VmNode({ data, selected }: P) {
  return <LeafCard data={data} selected={selected} Icon={Box} />;
}

export function ArrayNode({ data, selected }: P) {
  return (
    <GroupFrame
      data={data}
      selected={selected}
      Icon={Database}
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
  return <GroupFrame data={data} selected={selected} Icon={HardDrive} title={data.device.label} />;
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

export function IfaceNode({ data, selected }: P) {
  const { device } = data;
  const vlan = device.fields.vlan;
  return (
    <div
      className="nv-node relative flex h-full w-full items-center gap-1 overflow-hidden rounded bg-panel-2 px-1"
      style={frameStyle(device)}
      {...nodeAttrs(data, selected)}
    >
      <span className="truncate font-mono text-[9px]">
        {device.label}
        {typeof device.fields.ip === 'string' && device.kind === 'fa-interface'
          ? ` ${device.fields.ip}`
          : ''}
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

export function VswitchNode({ data, selected }: P) {
  const mode = String(data.device.fields.bondMode ?? '');
  return (
    <LeafCard data={data} selected={selected} className="bg-panel-2">
      <span className="truncate text-[10px]">
        <span className="font-semibold">{data.device.label}</span>
        <span className="text-ink-muted"> · {BOND_MODE_LABEL[mode] ?? mode}</span>
      </span>
    </LeafCard>
  );
}

export function DiskNode({ data, selected }: P) {
  return (
    <LeafCard data={data} selected={selected} className="px-1">
      <span className="truncate font-mono text-[9px]">{data.device.label}</span>
    </LeafCard>
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
