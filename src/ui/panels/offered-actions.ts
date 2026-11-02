import type { ActionSpec } from '../../engine/types';

/**
 * Failure actions the UI does not offer. They stay in the engine (guided scenarios and tests
 * apply them), but the inspector keeps one clear way to break each thing: hard stop or
 * maintenance mode for a CVM or host, fail or cable-pull for hardware. A hard CVM stop covers
 * Stargate crash, hang and restart; flaps, grey failures and reboots are variations of the same
 * outage.
 */
const HIDDEN = new Set([
  'reboot',
  'hang',
  'unhang',
  'link.flap',
  'link.set-loss',
  'set-latency',
  'switch.hang',
  'fa.interface.flap',
  'fa.io-stall',
  'fa.ndu',
  'vm.snapshot',
  'host.isolate',
  'host.unisolate',
  'cvm.stop-stargate',
  'cvm.start-stargate',
  'cvm.crash-stargate',
  'cvm.hang-stargate',
  'cvm.resume-stargate',
  'cvm.network-flap',
  'cvm.network-loss',
  'cvm.internal-link-down',
  'cvm.internal-link-up',
  'cvm.mark-fixed',
  'vm.pause',
  'vm.resume',
]);

export const isOfferedAction = (spec: Pick<ActionSpec, 'kind'>): boolean => !HIDDEN.has(spec.kind);
