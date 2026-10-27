/**
 * Status and badge primitives. Status is never conveyed by color alone (SPEC §8): every status
 * has a distinct icon shape and a text label (visible, or as the accessible name).
 */
import { clsx } from 'clsx';
import {
  BadgeCheck,
  Ban,
  CircleCheck,
  CircleHelp,
  CirclePause,
  CircleX,
  Crown,
  FlaskConical,
  Hourglass,
  Lightbulb,
  type LucideIcon,
  PowerOff,
  Star,
  TriangleAlert,
  Vote,
} from 'lucide-react';
import type { Confidence, DeviceStatus } from '../../engine/types';

export const STATUS_META: Readonly<Record<DeviceStatus, { label: string; Icon: LucideIcon }>> = {
  healthy: { label: 'Healthy', Icon: CircleCheck },
  degraded: { label: 'Degraded', Icon: TriangleAlert },
  stalled: { label: 'Stalled', Icon: CirclePause },
  failed: { label: 'Failed', Icon: CircleX },
  fenced: { label: 'Fenced', Icon: Ban },
  offline: { label: 'Offline', Icon: PowerOff },
  unknown: { label: 'Unknown', Icon: CircleHelp },
};

export const statusColor = (status: DeviceStatus | 'up' | 'down'): string => {
  const s = status === 'up' ? 'healthy' : status === 'down' ? 'failed' : status;
  return `var(--color-status-${s})`;
};

export function StatusIcon({ status, size = 14 }: { status: DeviceStatus; size?: number }) {
  const { label, Icon } = STATUS_META[status];
  return (
    <Icon
      size={size}
      strokeWidth={2.25}
      style={{ color: statusColor(status) }}
      role="img"
      aria-label={label}
      className="shrink-0"
    />
  );
}

export function StatusPill({ status, className }: { status: DeviceStatus; className?: string }) {
  const { label, Icon } = STATUS_META[status];
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium leading-4',
        className,
      )}
      style={{
        color: statusColor(status),
        borderColor: `color-mix(in srgb, ${statusColor(status)} 45%, transparent)`,
        background: `color-mix(in srgb, ${statusColor(status)} 12%, transparent)`,
      }}
      data-status={status}
    >
      <Icon size={11} strokeWidth={2.5} aria-hidden="true" />
      {label}
    </span>
  );
}

const BADGES: Readonly<Record<string, { label: string; short: string; Icon: LucideIcon }>> = {
  'zk-leader': { label: 'ZK leader', short: 'ZK', Icon: Crown },
  zk: { label: 'ZK member', short: 'ZK', Icon: Vote },
  'acropolis-leader': { label: 'Acropolis leader', short: 'Acropolis', Icon: Crown },
  'fa-primary': { label: 'Primary controller', short: 'Primary', Icon: Star },
  'fa-promoting': { label: 'Promoting to primary', short: 'Promoting', Icon: Hourglass },
  'io-paused': { label: 'Array IO paused', short: 'IO paused', Icon: CirclePause },
};

export const badgeLabel = (b: string): string => BADGES[b]?.label ?? b;

/**
 * A role badge. `compact` shows the short label, `iconOnly` just the icon; the full label is
 * always the tooltip and accessible name.
 */
export function RoleBadge({
  badge,
  compact = false,
  iconOnly = false,
}: {
  badge: string;
  compact?: boolean;
  iconOnly?: boolean;
}) {
  const meta = BADGES[badge];
  const Icon = meta?.Icon;
  if (iconOnly && Icon) {
    return (
      <span
        title={meta.label}
        className="inline-flex shrink-0 items-center rounded border border-accent/40 bg-accent/10 px-px text-accent-ink"
        data-badge={badge}
      >
        <Icon size={9} strokeWidth={2.5} aria-hidden="true" />
        <span className="sr-only">{meta.label}</span>
      </span>
    );
  }
  return (
    <span
      title={meta?.label ?? badge}
      className="inline-flex items-center gap-0.5 rounded border border-accent/40 bg-accent/10 px-1 text-[10px] font-medium leading-4 text-accent-ink"
      data-badge={badge}
    >
      {Icon ? <Icon size={10} strokeWidth={2.5} aria-hidden="true" /> : null}
      {compact ? (
        <>
          <span aria-hidden="true">{meta?.short ?? badge}</span>
          <span className="sr-only">{meta?.label ?? badge}</span>
        </>
      ) : (
        (meta?.label ?? badge)
      )}
    </span>
  );
}

export const CONFIDENCE_META: Readonly<
  Record<Confidence, { label: string; Icon: LucideIcon; hint: string }>
> = {
  verified: { label: 'Verified', Icon: BadgeCheck, hint: 'Primary vendor doc or KB' },
  inferred: { label: 'Inferred', Icon: Lightbulb, hint: 'Derived from documented mechanisms' },
  unverified: { label: 'Unverified', Icon: CircleHelp, hint: 'Community post or third-party blog' },
  assumption: {
    label: 'Assumption',
    Icon: TriangleAlert,
    hint: 'No public source; modeled best guess',
  },
  'lab-observed': {
    label: 'Lab-observed',
    Icon: FlaskConical,
    hint: 'Measured on the test drive lab',
  },
};

export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const { label, Icon, hint } = CONFIDENCE_META[confidence];
  return (
    <span
      title={hint}
      className="inline-flex items-center gap-1 rounded border border-border px-1.5 text-[10px] font-medium leading-4 text-ink-muted"
      data-confidence={confidence}
    >
      <Icon size={11} aria-hidden="true" />
      {label}
    </span>
  );
}
