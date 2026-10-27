/**
 * Values stream F needs that the profile does not have yet. Each is a labeled `assumption` (SPEC
 * §2 item 5) and is requested as a profile field; until then domain code reads it from here, never
 * as an inline literal. Move each into `Profile` once the request lands (data-only change).
 */
import type { Cited } from '../../engine/types';
import { cited } from '../versions/cited';

export interface NutanixAssumptions {
  /** Host power-cycle time for `reboot` (POST + AHV boot), before its CVM starts booting. */
  readonly hostRebootS: Cited<number>;
  /**
   * A detached Cassandra node is re-added to the ring "after it has been stable" (Bible 4i,
   * KB-1256); the stable period is not published.
   */
  readonly cassandraRejoinStableS: Cited<number>;
  /**
   * After a per-VM path-loss force-shutdown, AHV HA restarts the VM "at the next HA cycle"
   * (SPEC §14 #7); modeled as this many heartbeat intervals.
   */
  readonly forceShutdownRestartCycles: Cited<number>;
}

export const NUTANIX_ASSUMPTIONS: NutanixAssumptions = {
  hostRebootS: cited(
    300,
    'assumption',
    [],
    'No published figure; server POST + AHV boot takes minutes. Long enough that HA fences and restarts the VMs (as for a power loss).',
  ),
  cassandraRejoinStableS: cited(
    600,
    'assumption',
    ['ntnx-bible-4i', 'ntnx-kb-1256'],
    'Auto ring-repair re-adds a detached node after it has been stable for an unspecified time.',
  ),
  forceShutdownRestartCycles: cited(
    1,
    'assumption',
    ['ntnx-ncp-everpure-deploy-7.6'],
    'SPEC §14 #7: restarted through AHV HA at the next HA cycle (one heartbeat interval).',
  ),
};
