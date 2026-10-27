import { Bug, CircleX, Info, type LucideIcon, OctagonAlert, TriangleAlert } from 'lucide-react';
import type { Severity } from '../../engine/types';

export const SEVERITY_META: Readonly<
  Record<Severity, { label: string; Icon: LucideIcon; color: string }>
> = {
  debug: { label: 'Debug', Icon: Bug, color: 'var(--color-ink-muted)' },
  info: { label: 'Info', Icon: Info, color: 'var(--color-accent-ink)' },
  warn: { label: 'Warning', Icon: TriangleAlert, color: 'var(--color-status-degraded)' },
  error: { label: 'Error', Icon: CircleX, color: 'var(--color-status-failed)' },
  critical: { label: 'Critical', Icon: OctagonAlert, color: 'var(--color-status-failed)' },
};

export function SeverityTag({ severity }: { severity: Severity }) {
  const { label, Icon, color } = SEVERITY_META[severity];
  return (
    <span
      className="inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase"
      style={{ color }}
    >
      <Icon size={11} aria-hidden="true" />
      {label}
    </span>
  );
}
