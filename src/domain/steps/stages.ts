/**
 * The failure sequence as STAGES, placed on the relative step scale (see `scale.ts`).
 *
 * The engine clock is internal. What a user is meant to read is the order of the stages and how
 * many steps an interruption spans, never a duration: a step is an ordinal on a relative scale
 * (no interruption, brief, longer, redirected later, recovered), and nothing here or in the UI
 * may equate a step with seconds.
 *
 * Every stage below has a public-safe description and a citation or a labeled
 * `assumption`. The ORDER of the stages and the relative size of the gaps between them is
 * `lab-observed` (measured on our own instance; no figures are published, SPEC §2); the
 * mechanisms are cited from the vendor documents.
 */
import type { Confidence } from '../../engine/types';
import type { KnownCitationId } from '../citations';

export type StepStage =
  /** The VM's IO stops completing (or waits behind commands queued on a lost path). */
  | 'stall'
  /** Every NVMe path of the serving CVM is declared lost. */
  | 'all-paths-lost'
  /** A path is declared lost while another fabric still works: multipath retries there. */
  | 'path-rerouted'
  /** Hades puts the node in maintenance mode (its service volumes are unreachable). */
  | 'maintenance'
  /** Genesis stops the node's services; its Stargate process exits and resets connections. */
  | 'services-stopped'
  /** The AHV redirector sends each vDisk session to a remote CVM's Stargate; IO can resume. */
  | 'redirected'
  /** The VM itself is down: its process stopped (host failure, self-termination, or a fault). */
  | 'vm-down'
  /** AHV HA started the VM again on another host (its own outcome, not a redirect). */
  | 'ha-restarted'
  /** The VM's IO completes again (see `resumeStep`). */
  | 'resumed'
  /** Recovery, after the failure ends; the VM is not interrupted by any of it. */
  | 'path-restored'
  | 'maintenance-exited'
  | 'services-restarted'
  | 'failed-back'
  /**
   * A planned array operation (a controller reboot, or the reboots of an NDU). These belong to
   * the array's own run, not to a VM's: the step counter climbs through them while no VM stalls.
   */
  | 'controller-draining'
  | 'controller-rebooting'
  | 'controller-online'
  | 'controller-failover';

export interface StageInfo {
  readonly stage: StepStage;
  readonly label: string;
  /** Public-safe explanation: no durations, no lab figures. */
  readonly text: string;
  readonly cite: readonly KnownCitationId[];
  readonly confidence: Confidence;
  /** Engine event code that marks it (null: read from the VM view). */
  readonly eventCode: string | null;
}

export const STAGES: Readonly<Record<StepStage, StageInfo>> = {
  stall: {
    stage: 'stall',
    label: 'IO stalls',
    text: 'The VM keeps sending IO to its local CVM, but the CVM can no longer complete it (its array paths are failing). The VM sees a normal-looking stall.',
    cite: ['ntnx-bible-5b', 'nvme-base-spec-2.1'],
    confidence: 'lab-observed',
    eventCode: null,
  },
  'all-paths-lost': {
    stage: 'all-paths-lost',
    label: 'Every array path lost',
    text: 'The CVM declares every NVMe/TCP path lost (keep-alive).',
    cite: ['nvme-base-spec-2.1', 'everpure-nutanix-301-deck'],
    confidence: 'verified',
    eventCode: 'nvme.all-paths.lost',
  },
  'path-rerouted': {
    stage: 'path-rerouted',
    label: 'Path lost, IO retried elsewhere',
    text: 'With another fabric still working, the lost path is abandoned and the stuck commands are retried on a surviving path. A short interruption, no service restarts.',
    cite: ['spdk-nvme-multipath', 'nvme-base-spec-2.1', 'everpure-nutanix-301-deck'],
    confidence: 'inferred',
    eventCode: 'nvme.path.lost',
  },
  maintenance: {
    stage: 'maintenance',
    label: 'Node enters maintenance mode',
    text: 'Hades finds the CVM service volumes unreachable and puts the node in maintenance mode.',
    cite: ['ntnx-cmdref-aos-7.6', 'ntnx-bible-8c'],
    confidence: 'inferred',
    eventCode: 'hades.maintenance.enter',
  },
  'services-stopped': {
    stage: 'services-stopped',
    label: 'Services stop, Stargate exits',
    text: 'The node services are stopped and the local Stargate process exits, resetting its connections.',
    cite: ['ntnx-cmdref-aos-7.6', 'ntnx-pe-alerts-7.0-cluster'],
    confidence: 'lab-observed',
    eventCode: 'hades.services.stopped',
  },
  redirected: {
    stage: 'redirected',
    label: 'Redirected to remote CVMs',
    text: 'The AHV redirector marks the local portal down and sends each vDisk to a remote CVM over the host management uplinks. IO resumes shortly after.',
    cite: ['ntnx-bible-5b', 'odgers-ahv-io-failover-2015'],
    confidence: 'lab-observed',
    eventCode: 'redirector.redirect',
  },
  'vm-down': {
    stage: 'vm-down',
    label: 'VM down',
    text: 'The VM process is no longer running: its host failed, it was shut down because no Stargate served its disks, or it failed itself. Its IO stops until it runs again.',
    cite: ['ntnx-ahv-admin-11.2', 'ntnx-bible-5b'],
    confidence: 'inferred',
    eventCode: 'vm.crashed',
  },
  'ha-restarted': {
    stage: 'ha-restarted',
    label: 'Restarted by AHV HA',
    text: 'AHV HA powers the VM on again on another host that can run it. It is a fresh boot there, served by that host’s CVM: not a redirect, and nothing fails back later.',
    cite: ['ntnx-ahv-admin-11.2', 'ntnx-bible-5b'],
    confidence: 'inferred',
    eventCode: 'ha.vm.restarted',
  },
  resumed: {
    stage: 'resumed',
    label: 'IO completes again',
    text: 'The VM IO completes again.',
    cite: ['ntnx-bible-5b'],
    confidence: 'lab-observed',
    eventCode: null,
  },
  'path-restored': {
    stage: 'path-restored',
    label: 'Paths restored',
    text: 'The failed paths reconnect. Nothing is interrupted.',
    cite: ['nvme-base-spec-2.1'],
    confidence: 'inferred',
    eventCode: 'nvme.path.restored',
  },
  'maintenance-exited': {
    stage: 'maintenance-exited',
    label: 'Node leaves maintenance mode',
    text: 'The next volume check finds the service volumes healthy and the node leaves maintenance mode.',
    cite: ['ntnx-cmdref-aos-7.6'],
    confidence: 'inferred',
    eventCode: 'hades.maintenance.exit',
  },
  'services-restarted': {
    stage: 'services-restarted',
    label: 'Services restart',
    text: 'The local Stargate is serving again, but the VM stays on the remote CVM for now.',
    cite: ['ntnx-cmdref-aos-7.6'],
    confidence: 'inferred',
    eventCode: 'stargate.up',
  },
  'failed-back': {
    stage: 'failed-back',
    label: 'Sessions fail back, no interruption',
    text: 'After the local Stargate has been stable for a long while, the redirector moves each vDisk back to the local CVM one at a time, without a stall. Much later than the failover.',
    cite: ['odgers-ahv-io-failover-2015', 'ntnx-bible-5b'],
    confidence: 'unverified',
    eventCode: 'redirector.failback',
  },
  'controller-draining': {
    stage: 'controller-draining',
    label: 'Controller drains',
    text: 'The controller stops taking new IO: it answers with ANA Inaccessible, so each host retries the IO on the other controller’s paths at once. The IO already in flight finishes. No VM IO stalls.',
    cite: ['everpure-upgrade', 'everpure-ana-faq', 'nvme-base-spec-2.1'],
    confidence: 'assumption',
    eventCode: 'fa.controller.draining',
  },
  'controller-rebooting': {
    stage: 'controller-rebooting',
    label: 'Controller reboots',
    text: 'With nothing left in flight on it, the controller reboots and its ports disappear. The hosts lose those paths without waiting on any IO.',
    cite: ['everpure-upgrade', 'everpure-npiv'],
    confidence: 'assumption',
    eventCode: 'fa.controller.rebooting',
  },
  'controller-online': {
    stage: 'controller-online',
    label: 'Controller back online',
    text: 'The controller is back as secondary; the hosts reconnect and IO uses its paths again.',
    cite: ['everpure-upgrade'],
    confidence: 'assumption',
    eventCode: 'fa.controller.online',
  },
  'controller-failover': {
    stage: 'controller-failover',
    label: 'Planned failover',
    text: 'The primary gives back and the upgraded controller promotes, with a short array-wide IO pause.',
    cite: ['everpure-ha-planned', 'everpure-upgrade'],
    confidence: 'assumption',
    eventCode: 'fa.promotion.complete',
  },
};

/**
 * The relative scale shown to users for how an interruption ended (never a duration):
 * `restarted` is a VM that AHV HA started again on another host; `down` a VM that is down with
 * nothing restarting it (failed or paused by the user, or no host can run it).
 */
export type ImpactScale = 'none' | 'brief' | 'longer' | 'redirected' | 'restarted' | 'down';
