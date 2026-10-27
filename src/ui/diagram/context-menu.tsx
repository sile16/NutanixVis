/**
 * Right-click quick menu (SPEC §8): fail / recover (or cable down / up) for the clicked device or
 * cable, plus a jump to the Inspector for everything else. Keyboard: arrows move, Escape closes.
 * Also reachable with the context-menu key / Shift+F10 on a focused node.
 */
import { PanelRight } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef } from 'react';
import { useClampedPosition } from '../components/clamp';
import { useSim, useSimControls, useSnapshot } from '../store/sim-context';
import { useUi } from '../store/ui-store';

const QUICK = new Set(['fail', 'recover', 'link-down', 'link-up']);

export function ContextMenu() {
  const menu = useUi((s) => s.contextMenu);
  const close = useUi((s) => s.openContextMenu);
  const select = useUi((s) => s.select);
  const setTab = useUi((s) => s.setTab);
  const sim = useSim();
  useSnapshot(); // re-render when applicability changes
  const { apply } = useSimControls();
  const ref = useRef<HTMLDivElement>(null);
  const pos = useClampedPosition(ref, menu ? { x: menu.x, y: menu.y } : null);

  useEffect(() => {
    if (!menu) return;
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menu, close]);

  if (!menu) return null;
  const actions = sim.availableActions(menu.target.id).filter((a) => QUICK.has(a.kind));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
    ];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close(null);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Quick actions for ${menu.target.id}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed z-50 min-w-44 rounded-md border border-border bg-panel p-1 text-sm shadow-lg"
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y }}
      data-testid="context-menu"
    >
      <div className="truncate px-2 py-1 font-mono text-[11px] text-ink-muted">
        {menu.target.id}
      </div>
      {actions.map((a) => (
        <button
          key={a.kind}
          type="button"
          role="menuitem"
          className="flex w-full items-center rounded px-2 py-1 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
          onClick={() => {
            apply({ kind: a.kind, target: menu.target.id });
            close(null);
          }}
        >
          {a.label}
        </button>
      ))}
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-ink-muted hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
        onClick={() => {
          select(menu.target);
          setTab('inspector');
        }}
      >
        <PanelRight size={13} aria-hidden="true" />
        All actions…
      </button>
    </div>
  );
}
