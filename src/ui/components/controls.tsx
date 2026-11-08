/** Small, keyboard-accessible control primitives styled with the theme tokens. */
import { clsx } from 'clsx';
import { CircleHelp } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
};

export function Button({
  variant = 'default',
  size = 'md',
  className,
  type,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type === 'submit' ? 'submit' : 'button'}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
        'disabled:cursor-not-allowed disabled:opacity-45',
        size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-2.5 text-sm',
        variant === 'primary' && 'border-accent bg-accent text-on-accent hover:bg-accent/90',
        variant === 'default' && 'border-border bg-panel-2 text-ink hover:bg-hover',
        variant === 'ghost' && 'border-transparent text-ink-muted hover:bg-hover hover:text-ink',
        variant === 'danger' &&
          'border-status-failed/50 bg-status-failed/10 text-status-failed hover:bg-status-failed/20',
        className,
      )}
      {...rest}
    />
  );
}

export function Select({
  label,
  hideLabel,
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hideLabel?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
      <span className={hideLabel ? 'sr-only' : undefined}>{label}</span>
      <select
        className={clsx(
          'h-8 rounded-md border border-border bg-panel-2 px-2 text-sm normal-case tracking-normal text-ink',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
          className,
        )}
        {...rest}
      >
        {children}
      </select>
    </label>
  );
}

/** A share bar with its percentage as text (never color alone). */
export function ShareBar({
  label,
  share,
  detail,
  tone = 'accent',
  down,
}: {
  label: string;
  share: number;
  detail?: string;
  tone?: 'accent' | 'muted';
  down?: boolean;
}) {
  const pct = Math.round(share * 100);
  return (
    <div
      className="grid grid-cols-[6.5rem_1fr_3rem] items-center gap-2 text-xs"
      data-share-label={label}
    >
      <span className="truncate text-ink" title={label}>
        {label}
        {down ? <span className="ml-1 text-status-failed">(down)</span> : null}
      </span>
      {/* Decorative: the percentage is the text next to it. */}
      <span className="h-2 overflow-hidden rounded-full bg-hover" aria-hidden="true">
        <span
          className={clsx(
            'block h-full rounded-full',
            tone === 'accent' ? 'bg-accent' : 'bg-ink-muted',
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="text-right font-mono text-ink-muted" title={detail}>
        {pct}%
      </span>
    </div>
  );
}

/**
 * A circled "?" that shows a short explanation on hover or keyboard focus (and to screen readers
 * through `aria-describedby`). The popover sits below the icon; `align` keeps it on screen.
 */
export function HelpTip({
  id,
  label,
  children,
  align = 'left',
}: {
  id: string;
  /** Accessible name of the icon button, e.g. "What is a step?". */
  label: string;
  children: ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
        data-testid={`help-${id}`}
      >
        <CircleHelp size={14} aria-hidden="true" />
      </button>
      <span
        id={id}
        role="tooltip"
        className={clsx(
          'pointer-events-none invisible absolute top-full z-50 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-panel px-3 py-2 text-xs leading-relaxed text-ink opacity-0 shadow-lg transition-opacity',
          'group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100',
          align === 'left' ? 'left-0' : 'right-0',
        )}
      >
        {children}
      </span>
    </span>
  );
}
