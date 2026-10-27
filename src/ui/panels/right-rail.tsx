/** Tabbed right rail (SPEC §8): Inspector, Events, Explain, Scenario. Radix Tabs (keyboard nav). */
import { Tabs } from 'radix-ui';
import { type RailTab, useUi } from '../store/ui-store';
import { EventsPanel } from './events-panel';
import { ExplainPanel } from './explain-panel';
import { Inspector } from './inspector';
import { ScenarioPanel } from './scenario-panel';

const TABS: readonly { id: RailTab; label: string }[] = [
  { id: 'inspector', label: 'Inspector' },
  { id: 'events', label: 'Events' },
  { id: 'explain', label: 'Explain' },
  { id: 'scenario', label: 'Scenario' },
];

const isTab = (v: string): v is RailTab => TABS.some((t) => t.id === v);

export function RightRail() {
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);
  return (
    <Tabs.Root
      value={tab}
      onValueChange={(v) => isTab(v) && setTab(v)}
      className="flex h-full min-h-0 flex-col"
      data-testid="right-rail"
    >
      <Tabs.List aria-label="Details" className="flex shrink-0 border-b border-border px-1">
        {TABS.map((t) => (
          <Tabs.Trigger
            key={t.id}
            value={t.id}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-focus data-[state=active]:border-accent data-[state=active]:font-medium data-[state=active]:text-ink"
          >
            {t.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      <Tabs.Content value="inspector" className="min-h-0 flex-1 overflow-y-auto">
        <Inspector />
      </Tabs.Content>
      <Tabs.Content value="events" className="min-h-0 flex-1 overflow-hidden">
        <EventsPanel />
      </Tabs.Content>
      <Tabs.Content value="explain" className="min-h-0 flex-1 overflow-y-auto">
        <ExplainPanel />
      </Tabs.Content>
      <Tabs.Content value="scenario" className="min-h-0 flex-1 overflow-y-auto">
        <ScenarioPanel />
      </Tabs.Content>
    </Tabs.Root>
  );
}
