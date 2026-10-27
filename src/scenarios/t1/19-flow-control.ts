import { defineScenario } from '../define';
import { atCtx, baseInvariants, eventSeen, T0 } from '../helpers';
import { SW_A, SW_B, T1 } from '../ids';

export default defineScenario({
  id: 't1-19-flow-control-enabled',
  title: 'T1 misconfiguration: PFC enabled on the storage switches',
  topology: T1.topology,
  options: { 'flow-control': 'pfc' },
  durationS: T0 + 20,
  timeline: [],
  // Effects of pause frames on NVMe/TCP are modeled later; for now only the warning is asserted.
  expect: [
    atCtx(
      T0,
      'both switches are flagged for unsupported flow control',
      (_s, ctx) =>
        eventSeen(ctx, 'switch.flow-control.unsupported', { device: SW_A }) &&
        eventSeen(ctx, 'switch.flow-control.unsupported', { device: SW_B }),
    ),
    ...baseInvariants(),
  ],
  narrative:
    'Priority Flow Control is enabled on both storage switches. Everpure does not support PFC or Global Pause with FlashArray NVMe/TCP and asks for both to be disabled, so the simulator flags the configuration.',
  cite: ['everpure-nutanix-net-bp'],
  status: 'active',
});
