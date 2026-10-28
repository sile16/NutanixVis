/**
 * Citation registry (SPEC §2). PUBLIC sources only — the repo and site are public.
 * Never add internal links (Slack, Jira, internal docs); `pnpm check:public` enforces this.
 * Stream C owns the entries; ids are referenced from profiles, events and scenarios.
 *
 * Portal guides are cited by their portal title and `targetId` URL (the portal renders with
 * JavaScript; a free login may be needed). Community posts (`Community`) support only
 * `unverified` claims.
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

const RETRIEVED = '2026-10-27';
const PORTAL_DOC = 'https://portal.nutanix.com/page/documents/details?targetId=';
const EVERPURE = 'https://support.everpuredata.com/r/';
const BIBLE = 'https://www.nutanixbible.com/';
const NEXT = 'https://next.nutanix.com/';

type Entry = Omit<Citation, 'id' | 'retrieved'>;

const entries = {
  // ── Nutanix Bible ──────────────────────────────────────────────────────────
  'ntnx-bible-4a': {
    title: 'The Nutanix Bible — Book of AOS: Architecture',
    url: `${BIBLE}4a-book-of-aos-architecture.html`,
    publisher: 'Nutanix',
  },
  'ntnx-bible-4g': {
    title: 'The Nutanix Bible — Book of AOS: Data I/O Path',
    url: `${BIBLE}4g-book-of-aos-data-io-path.html`,
    publisher: 'Nutanix',
  },
  'ntnx-bible-4i': {
    title: 'The Nutanix Bible — Book of AOS: Data Resilience and HA',
    url: `${BIBLE}4i-book-of-aos-data-resilience-and-ha.html`,
    publisher: 'Nutanix',
  },
  'ntnx-bible-5a': {
    title: 'The Nutanix Bible — Book of AHV: Architecture',
    url: `${BIBLE}5a-book-of-ahv-architecture.html`,
    publisher: 'Nutanix',
  },
  'ntnx-bible-5b': {
    title: 'The Nutanix Bible — Book of AHV: How It Works',
    url: `${BIBLE}5b-book-of-ahv-how-it-works.html`,
    publisher: 'Nutanix',
  },
  'ntnx-bible-8b': {
    title: 'The Nutanix Bible — External Storage: High-Level Design',
    url: `${BIBLE}8b-book-of-external-storage-high-level-design.html`,
    publisher: 'Nutanix',
  },
  'ntnx-bible-8c': {
    title: 'The Nutanix Bible — External Storage: Architecture',
    url: `${BIBLE}8c-book-of-external-storage-architecture.html`,
    publisher: 'Nutanix',
  },

  // ── Nutanix portal docs and KBs ────────────────────────────────────────────
  'ntnx-ahv-admin-11.2': {
    title: 'AHV Administration Guide (AHV 11.2)',
    url: `${PORTAL_DOC}AHV-Admin-Guide-v11_2:AHV-Admin-Guide-v11_2`,
    publisher: 'Nutanix',
  },
  'ntnx-ncp-everpure-deploy-7.6': {
    title:
      'Nutanix Cloud Platform with Everpure FlashArray Deployment Guide (NCP with Everpure FlashArray 7.6)',
    url: `${PORTAL_DOC}Nutanix-Cloud-Platform-with-Pure-Storage-Deployment-Guide-v7_6:Nutanix-Cloud-Platform-with-Pure-Storage-Deployment-Guide-v7_6`,
    publisher: 'Nutanix',
  },
  'ntnx-ncp-everpure-compat-7.6': {
    title: 'NCP with Everpure FlashArray Compatibility and Interoperability Matrix 7.6',
    url: `${PORTAL_DOC}Nutanix-Cloud-Platform-with-Pure-Storage-Compatibility-and-Interoperability-Matrix-v7_6:Nutanix-Cloud-Platform-with-Pure-Storage-Compatibility-and-Interoperability-Matrix-v7_6`,
    publisher: 'Nutanix',
  },
  'ntnx-storage-compat-matrix': {
    title: 'Nutanix Compatibility and Interoperability Matrix — External Storage',
    url: 'https://portal.nutanix.com/page/compatibility-interoperability-matrix/storage',
    publisher: 'Nutanix',
  },
  'ntnx-kb-1256': {
    title: 'Nutanix KB-1256: Cassandra node auto ring-repair / detach from metadata ring',
    url: 'https://portal.nutanix.com/kb/1256',
    publisher: 'Nutanix',
  },
  'ntnx-blog-cvm-failure': {
    title: 'Nutanix blog — Nutanix Controller Failure. Will Users Notice? (archived copy)',
    url: 'https://web.archive.org/web/20250212144800/https://www.nutanix.com/blog/nutanix-controller-failure-will-users-notice',
    publisher: 'Nutanix',
  },

  // ── Everpure: Nutanix integration ──────────────────────────────────────────
  'everpure-nutanix-req': {
    title: 'Nutanix and Everpure Requirements, Limits and Feature Compatibility',
    url: `${EVERPURE}nutanix/nutanix-and-everpure-requirements-limits-and-compatibility`,
    publisher: 'Everpure',
  },
  'everpure-nutanix-rn': {
    title: 'Release Notes: Nutanix and Everpure Integration',
    url: `${EVERPURE}nutanix/release-notes-nutanix-and-everpure-integration`,
    publisher: 'Everpure',
  },
  'everpure-nutanix-301-deck': {
    title:
      'Nutanix + Everpure 301 Technical Deck (Everpure, 2026): "Multipathing and NVMe timers (KATO 5 s, controller loss 3600 s, CQT 30 s) are set automatically and must not be changed." Training deck, not hosted publicly; link is the Everpure Nutanix documentation hub. Publication approved by the owner (2026-10-27).',
    url: `${EVERPURE}nutanix`,
    publisher: 'Everpure',
  },
  'everpure-nutanix-net-bp': {
    title: 'Network Configuration for NCP with FlashArray',
    url: `${EVERPURE}nutanix/nutanix-everpure-bp-network-config`,
    publisher: 'Everpure',
  },
  'everpure-nutanix-cfg': {
    title: 'Configure Nutanix Cluster for FlashArray',
    url: `${EVERPURE}nutanix/configure-nutanix-cluster-for-flasharray`,
    publisher: 'Everpure',
  },
  'everpure-fa-rep-nutanix': {
    title: 'Using FA Replication with Nutanix',
    url: `${EVERPURE}nutanix/fa-rep-nutanix-using-fa-replication`,
    publisher: 'Everpure',
  },

  // ── Everpure: Purity//FA controller HA ─────────────────────────────────────
  'everpure-ha-explained': {
    title: 'HA Failover Explained',
    url: `${EVERPURE}purityfa-general-administration/ha-failover-explained`,
    publisher: 'Everpure',
  },
  'everpure-ha-timing': {
    title: 'HA Timing Objectives',
    url: `${EVERPURE}purityfa-general-administration/ha-timing-objectives`,
    publisher: 'Everpure',
  },
  'everpure-ha-crash': {
    title: 'Primary Crash or Quorum Loss',
    url: `${EVERPURE}purityfa-general-administration/primary-crash-or-quorum-loss`,
    publisher: 'Everpure',
  },
  'everpure-ha-planned': {
    title: 'Planned Failover',
    url: `${EVERPURE}purityfa-general-administration/planned-failover`,
    publisher: 'Everpure',
  },
  'everpure-ha-secondary': {
    title: 'Secondary Crash',
    url: `${EVERPURE}purityfa-general-administration/secondary-crash`,
    publisher: 'Everpure',
  },
  'everpure-ha-iodelay': {
    title: 'IO Delay/Timeout',
    url: `${EVERPURE}purityfa-general-administration/io-delaytimeout`,
    publisher: 'Everpure',
  },
  'everpure-ha-scenarios': {
    title: 'HA Failover Scenarios and Behavior',
    url: `${EVERPURE}purityfa-general-administration/ha-failover-scenarios-and-behavior`,
    publisher: 'Everpure',
  },
  'everpure-upgrade': {
    title: 'Performing the Upgrade (Purity//FA upgrades)',
    url: `${EVERPURE}purityfa-upgrades/performing-the-upgrade-05`,
    publisher: 'Everpure',
  },

  // ── Everpure: host connectivity ────────────────────────────────────────────
  'everpure-host-timeouts': {
    title: 'Setting Host Disk Timeouts',
    url: `${EVERPURE}flasharray-connectivity/setting-host-disk-timeouts`,
    publisher: 'Everpure',
  },
  'everpure-nvme-tcp-bp': {
    title: 'NVMe/TCP Best Practices',
    url: `${EVERPURE}flasharray-connectivity/nvme-tcp-best-practices`,
    publisher: 'Everpure',
  },
  'everpure-ana-faq': {
    title: 'FAQ: NVMe-oF and VMware',
    url: `${EVERPURE}howtos-for-vmware-solutions/faq-nvmeof-and-vmware`,
    publisher: 'Everpure',
  },
  'everpure-npiv': {
    title: 'What does NPIV look like in action',
    url: `${EVERPURE}flasharray-block-services/what-does-npiv-look-like-in-action`,
    publisher: 'Everpure',
  },

  // ── Open source and standards ──────────────────────────────────────────────
  'ovs-vswitchd-conf': {
    title: 'ovs-vswitchd.conf.db(5) — Open vSwitch database schema',
    url: 'https://www.openvswitch.org/support/dist-docs/ovs-vswitchd.conf.db.5.txt',
    publisher: 'Open vSwitch',
  },
  'ovs-bonding': {
    title: 'Open vSwitch documentation — Bonding',
    url: 'https://docs.openvswitch.org/en/latest/topics/bonding/',
    publisher: 'Open vSwitch',
  },
  'ovs-lacp-source': {
    title: 'Open vSwitch source — lib/lacp.c (LACP receive timer and fallback-ab attach rules)',
    url: 'https://github.com/openvswitch/ovs/blob/main/lib/lacp.c',
    publisher: 'Open vSwitch',
  },
  'spdk-nvme-multipath': {
    title: 'SPDK documentation — NVMe Multipath',
    url: 'https://spdk.io/doc/nvme_multipath.html',
    publisher: 'SPDK',
  },
  'spdk-jsonrpc': {
    title: 'SPDK documentation — JSON-RPC (bdev_nvme_set_options, bdev_nvme_attach_controller)',
    url: 'https://spdk.io/doc/jsonrpc.html',
    publisher: 'SPDK',
  },
  'nvme-tcp-spec': {
    title: 'NVM Express TCP Transport Specification',
    url: 'https://nvmexpress.org/specification/tcp-transport-specification/',
    publisher: 'NVM Express',
  },
  'nvme-base-spec': {
    title:
      'NVM Express Base Specification (Keep Alive, Command Quiesce Time / TP4129 KATO Corrections and Clarifications)',
    url: 'https://nvmexpress.org/specification/nvm-express-base-specification/',
    publisher: 'NVM Express',
  },

  // ── Nutanix community (unverified) ─────────────────────────────────────────
  'ntnx-community-cvm-components': {
    title: 'Nutanix Community — Controller VM Components',
    url: `${NEXT}how-it-works-22/controller-vm-components-38055`,
    publisher: 'Community',
  },
  'ntnx-community-rebuild-cvm-down': {
    title: 'Nutanix Community — Data rebuild when CVM is down and Oplog question',
    url: `${NEXT}how-it-works-22/data-rebuild-when-cvm-is-down-and-oplog-question-37706`,
    publisher: 'Community',
  },
  'ntnx-community-node-detach': {
    title: 'Nutanix Community — Understanding alert: node marked to be detached',
    url: `${NEXT}how-it-works-22/understanding-alert-node-marked-to-be-detached-state-37501`,
    publisher: 'Community',
  },
  'ntnx-community-dnd': {
    title: 'Nutanix Community — Degraded Node Detection',
    url: `${NEXT}ahv-virtualization-27/degraded-node-detection-42859`,
    publisher: 'Community',
  },
  'ntnx-community-beyond-ft': {
    title:
      'Nutanix Community — Data resiliency status critical: what happens when another node goes down',
    url: `${NEXT}how-it-works-22/data-resiliency-status-critical-what-happens-when-another-node-goes-down-32101`,
    publisher: 'Community',
  },
  'ntnx-community-segmentation': {
    title: 'Nutanix Community — Network segmentation and uplink redundancy',
    url: `${NEXT}conversations/42742`,
    publisher: 'Community',
  },
  'ntnx-community-two-node': {
    title: 'Nutanix Community — Two-node clusters',
    url: `${NEXT}how-it-works-22/two-node-clusters-39244`,
    publisher: 'Community',
  },
  'ntnx-community-two-node-failover': {
    title: 'Nutanix Community — Monitoring a two-node cluster during failover and upgrade',
    url: `${NEXT}how-it-works-22/monitoring-a-two-node-cluster-during-failover-and-upgrade-38932`,
    publisher: 'Community',
  },
  'ntnx-community-co-nodes-blog': {
    title: 'Nutanix Community — Supercharging your Nutanix AHV clusters with compute-only nodes',
    url: `${NEXT}community-blog-154/supercharging-your-nutanix-ahv-clusters-with-compute-only-nodes-33303`,
    publisher: 'Community',
  },
  'ntnx-community-rebuild-rate': {
    title: 'Josh Odgers: "Nutanix Resiliency – Part 1 – Node failure rebuild performance" (2018)',
    url: 'https://www.joshodgers.com/2018/05/30/nutanix-resiliency-part-1-node-failure-rebuild-performance/',
    publisher: 'Community',
  },
  'ntnx-community-slb-rebalance': {
    title:
      'Nutanix Community — VM network troubleshooting (bond_rebalance_interval, Nutanix technical marketing, 2020)',
    url: `${NEXT}questions/22699`,
    publisher: 'Community',
  },
  'ntnx-community-co-nodes': {
    title: 'Nutanix Community — What are the Nutanix compute nodes',
    url: `${NEXT}how-it-works-22/what-are-the-nutanix-compute-nodes-37488`,
    publisher: 'Community',
  },
} as const satisfies Record<string, Entry>;

/** Every known citation id (literal union, so typos in domain code fail to compile if typed). */
export type KnownCitationId = keyof typeof entries;

export const citations: Readonly<Record<CitationId, Citation>> = Object.freeze(
  Object.fromEntries(
    Object.entries(entries).map(([id, e]) => [
      id,
      Object.freeze({ id, ...e, retrieved: RETRIEVED }),
    ]),
  ),
);
