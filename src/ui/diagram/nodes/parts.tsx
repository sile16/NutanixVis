/** Building blocks shared by the device node components. */
import { Handle, Position } from '@xyflow/react';
import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import type { DeviceView } from '../../../engine/types';
import { RoleBadge, StatusIcon, statusColor } from '../../components/status';
import type { DeviceNodeData, PortHandle } from '../flow';

const POSITION = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
} as const;

/** Each port is its own handle, so every cable has a distinct endpoint (SPEC §3). */
export function Ports({ ports }: { ports: readonly PortHandle[] }) {
  return (
    <>
      {ports.map((p) => (
        <Handle
          key={p.id}
          id={p.id}
          type="source"
          position={POSITION[p.side]}
          isConnectable={false}
          className="nv-port"
          style={{ left: p.x, top: p.y, right: 'auto', bottom: 'auto' }}
        />
      ))}
    </>
  );
}

type Vars = CSSProperties & Record<`--${string}`, string | undefined>;

export function frameStyle(device: DeviceView): Vars {
  return device.status === 'healthy' ? {} : { '--status': statusColor(device.status) };
}

export function nodeAttrs(data: DeviceNodeData, selected: boolean | undefined) {
  return {
    'data-testid': `node-${data.device.id}`,
    'data-status': data.device.status,
    'data-selected': selected ? 'true' : 'false',
    'data-dim': data.dim ? 'true' : 'false',
    'data-inpath': data.inPath ? 'true' : 'false',
    title: `${data.device.label} · ${data.device.status}`,
  } as const;
}

export function Badges({ badges, compact }: { badges: readonly string[]; compact?: boolean }) {
  if (badges.length === 0) return null;
  return (
    <span className="flex flex-nowrap gap-0.5">
      {badges.map((b) => (
        <RoleBadge key={b} badge={b} compact={compact ?? false} />
      ))}
    </span>
  );
}

/** A group frame (host, CVM with interfaces, FlashArray, controller, FA port with IPs). */
export function GroupFrame({
  data,
  selected,
  Icon,
  title,
  subtitle,
  tone = 'default',
  children,
}: {
  data: DeviceNodeData;
  selected: boolean | undefined;
  Icon: LucideIcon;
  title: string;
  subtitle?: string;
  tone?: 'default' | 'strong';
  children?: ReactNode;
}) {
  const { device, frame } = data;
  return (
    <div
      className={clsx(
        'nv-node relative h-full w-full rounded-lg',
        // Translucent bodies: cables run beneath groups and stay faintly visible.
        tone === 'strong' ? 'bg-group/60 shadow-sm' : 'bg-group/45',
      )}
      style={frameStyle(device)}
      {...nodeAttrs(data, selected)}
    >
      <div
        className="flex items-center gap-1.5 overflow-hidden rounded-t-lg bg-group-header px-2"
        style={{ height: frame.header }}
      >
        <Icon
          size={frame.header > 24 ? 14 : 12}
          className="shrink-0 text-ink-muted"
          aria-hidden="true"
        />
        <span
          className={clsx('shrink-0 font-semibold', frame.header > 24 ? 'text-xs' : 'text-[10px]')}
        >
          {title}
        </span>
        {subtitle ? <span className="truncate text-[10px] text-ink-muted">{subtitle}</span> : null}
        <StatusIcon status={device.status} size={frame.header > 24 ? 13 : 11} />
        <span className="ml-auto shrink-0">
          <Badges badges={device.badges} compact={frame.header < 28} />
        </span>
      </div>
      {children}
      <Ports ports={data.ports} />
    </div>
  );
}

/** A leaf card. */
export function LeafCard({
  data,
  selected,
  Icon,
  children,
  className,
}: {
  data: DeviceNodeData;
  selected: boolean | undefined;
  Icon?: LucideIcon;
  children?: ReactNode;
  className?: string;
}) {
  const { device } = data;
  return (
    <div
      className={clsx(
        'nv-node flex h-full w-full items-center gap-1 overflow-hidden rounded-md bg-panel px-1.5 text-ink shadow-sm',
        className,
      )}
      style={frameStyle(device)}
      {...nodeAttrs(data, selected)}
    >
      {Icon ? <Icon size={13} className="shrink-0 text-ink-muted" aria-hidden="true" /> : null}
      {children ?? <span className="truncate text-[11px] font-medium">{device.label}</span>}
      <span className="ml-auto flex items-center gap-0.5">
        <StatusIcon status={device.status} size={12} />
      </span>
      <Ports ports={data.ports} />
    </div>
  );
}

export const BOND_MODE_LABEL: Readonly<Record<string, string>> = {
  'active-backup': 'Active-Backup',
  'balance-slb': 'MAC pinning',
  'balance-tcp': 'LACP',
  'no-bond': 'No bond',
};
