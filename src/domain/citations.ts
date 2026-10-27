/**
 * Citation registry (SPEC §2). PUBLIC sources only — the repo and site are public.
 * Never add internal links (Slack, Jira, internal docs); `pnpm check:public` enforces this.
 * Stream C owns the entries; ids are referenced from profiles, events and scenarios.
 */
import type { CitationId } from '../engine/types';

export interface Citation {
  readonly id: CitationId;
  readonly title: string;
  /** Publicly reachable URL. Portal docs may require a free login; that is acceptable. */
  readonly url: string;
  readonly publisher:
    | 'Nutanix'
    | 'Everpure'
    | 'Open vSwitch'
    | 'SPDK'
    | 'NVM Express'
    | 'Community';
  /** ISO date the source was last checked. */
  readonly retrieved: string;
}

export const citations: Readonly<Record<CitationId, Citation>> = {
  'ntnx-bible-ahv-how-it-works': {
    id: 'ntnx-bible-ahv-how-it-works',
    title: 'The Nutanix Bible — AHV: How It Works',
    url: 'https://www.nutanixbible.com/5b-book-of-ahv-how-it-works.html',
    publisher: 'Nutanix',
    retrieved: '2026-10-27',
  },
};
