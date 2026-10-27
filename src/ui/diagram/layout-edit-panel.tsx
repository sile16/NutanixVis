import { Copy, Move, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/controls';
import { type DiagramLayout, exportLayout } from './layout';

/** Dev-only layout edit mode (SPEC §6.5): drag nodes, then copy the layout JSON for a topology. */
export function LayoutEditPanel({
  layout,
  onReset,
}: {
  layout: DiagramLayout;
  onReset: () => void;
}) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'shown'>('idle');
  const json = JSON.stringify(exportLayout(layout), null, 2);
  return (
    <div
      className="w-64 rounded-md border border-border bg-panel p-2 text-xs shadow-md"
      data-testid="layout-edit"
    >
      <div className="mb-1 flex items-center gap-1 font-semibold">
        <Move size={13} aria-hidden="true" /> Layout edit mode
      </div>
      <p className="mb-2 text-ink-muted">
        Drag devices; groups resize to fit. Copy the JSON into the topology's layout.
      </p>
      <div className="flex gap-1">
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(json);
              setCopied('ok');
            } catch {
              setCopied('shown');
            }
          }}
        >
          <Copy size={12} aria-hidden="true" /> Copy layout JSON
        </Button>
        <Button size="sm" onClick={onReset}>
          <RotateCcw size={12} aria-hidden="true" /> Reset
        </Button>
      </div>
      {copied === 'ok' ? <p className="mt-1 text-status-healthy">Copied to clipboard.</p> : null}
      {copied === 'shown' ? (
        <textarea
          readOnly
          aria-label="Layout JSON"
          className="mt-2 h-40 w-full rounded border border-border bg-panel-2 p-1 font-mono text-[10px]"
          value={json}
        />
      ) : null}
    </div>
  );
}
