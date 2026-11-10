/**
 * Compare dialog: the topology comparison chart (`./comparison`), the loaded topology's column
 * highlighted. A failure cell's "watch" link loads that topology and its guided scenario.
 */
import { clsx } from 'clsx';
import { Columns3, Play, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useState } from 'react';
import { guidedFor } from '../../scenarios/guided';
import { T1_CONFIGS, type T1ConfigKey } from '../../topologies/t1-configs';
import { Button } from '../components/controls';
import { useUi } from '../store/ui-store';
import { COLUMNS, COMPARISON, type Tone } from './comparison';

const TONE: Readonly<Record<Tone, string>> = {
  good: 'border-l-status-healthy',
  warn: 'border-l-status-stalled',
  bad: 'border-l-status-failed',
  neutral: 'border-l-transparent',
};

const TONE_WORD: Readonly<Record<Tone, string>> = {
  good: 'no impact',
  warn: 'short or partial impact',
  bad: 'lasting or silent risk',
  neutral: '',
};

const catalogIdOf = (key: T1ConfigKey): string =>
  T1_CONFIGS.find((c) => c.key === key)?.catalogId ?? key;

export function CompareButton() {
  const [open, setOpen] = useState(false);
  const topologyId = useUi((s) => s.topologyId);
  const setTopology = useUi((s) => s.setTopology);
  const loadScenario = useUi((s) => s.loadScenario);
  const setTab = useUi((s) => s.setTab);

  const watch = (key: T1ConfigKey, n: number) => {
    const catalogId = catalogIdOf(key);
    const g = guidedFor(catalogId).find((x) => x.family.n === n);
    if (!g) return;
    if (catalogId !== topologyId) setTopology(catalogId);
    loadScenario(g.def.id, catalogId);
    setTab('scenario');
    setOpen(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button
          size="sm"
          data-testid="compare-open"
          title="Compare the five storage-network topologies"
        >
          <Columns3 size={15} aria-hidden="true" />
          Compare
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          className="fixed inset-2 z-50 flex flex-col rounded-lg border border-border bg-panel text-ink shadow-xl sm:inset-6"
          data-testid="compare-dialog"
          aria-describedby="compare-desc"
        >
          <div className="flex items-start gap-3 border-b border-border px-4 py-3">
            <div className="flex-1">
              <Dialog.Title className="text-base font-semibold">Compare topologies</Dialog.Title>
              <p id="compare-desc" className="mt-0.5 text-xs text-ink-muted">
                The five storage networks side by side, as the simulator models them. Impacts are in
                steps, not seconds. Each failure cell opens the guided scenario that shows it on
                that topology.
              </p>
            </div>
            <Dialog.Close asChild>
              <Button size="sm" variant="ghost" title="Close" data-testid="compare-close">
                <X size={15} aria-hidden="true" />
                <span className="sr-only">Close</span>
              </Button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
            <table className="w-full min-w-[60rem] border-separate border-spacing-0 text-xs">
              <thead className="sticky top-0 z-10 bg-panel">
                <tr>
                  <th scope="col" className="w-40 border-b border-border p-2 text-left">
                    <span className="sr-only">Aspect</span>
                  </th>
                  {COLUMNS.map((c) => {
                    const here = catalogIdOf(c.key) === topologyId;
                    return (
                      <th
                        key={c.key}
                        scope="col"
                        className={clsx(
                          'border-b border-border p-2 text-left align-bottom',
                          here && 'bg-accent/15',
                        )}
                        data-testid={`compare-col-${c.key}`}
                        data-current={here ? 'yes' : 'no'}
                      >
                        <span className="block text-sm font-semibold">{c.head}</span>
                        <span className="block font-normal text-ink-muted">{c.sub}</span>
                        {here ? (
                          <span className="mt-0.5 block text-[10px] font-normal uppercase tracking-wide text-accent-ink">
                            loaded now
                          </span>
                        ) : null}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              {COMPARISON.map((section) => (
                <tbody key={section.title}>
                  <tr>
                    <th
                      scope="colgroup"
                      colSpan={COLUMNS.length + 1}
                      className="px-2 pb-1 pt-4 text-left text-[10px] font-semibold uppercase tracking-wide text-ink-muted"
                    >
                      {section.title}
                    </th>
                  </tr>
                  {section.rows.map((row) => (
                    <tr key={row.label}>
                      <th
                        scope="row"
                        className="border-b border-border p-2 text-left align-top font-medium"
                      >
                        {row.label}
                      </th>
                      {COLUMNS.map((c) => {
                        const cell = row.cells[c.key];
                        const tone = cell.tone ?? 'neutral';
                        const here = catalogIdOf(c.key) === topologyId;
                        return (
                          <td
                            key={c.key}
                            className={clsx(
                              'border-b border-l-4 border-b-border p-2 align-top',
                              TONE[tone],
                              here && 'bg-accent/10',
                            )}
                            data-tone={tone}
                          >
                            {tone !== 'neutral' ? (
                              <span className="sr-only">{TONE_WORD[tone]}: </span>
                            ) : null}
                            {cell.text}
                            {cell.try?.length ? (
                              <span className="mt-1 flex flex-wrap gap-1">
                                {cell.try.map((n) => (
                                  <button
                                    key={n}
                                    type="button"
                                    onClick={() => watch(c.key, n)}
                                    className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-ink-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
                                    data-testid={`compare-try-${c.key}-${n}`}
                                    title="Load this topology and run the guided scenario"
                                  >
                                    <Play size={9} aria-hidden="true" />
                                    scenario {n}
                                  </button>
                                ))}
                              </span>
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
            <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 px-2 text-[11px] text-ink-muted">
              <span className="flex items-center gap-1">
                <span className="inline-block h-3 w-1 bg-status-healthy" /> no impact
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-3 w-1 bg-status-stalled" /> short or partial impact
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-3 w-1 bg-status-failed" /> lasting or silent risk
              </span>
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
