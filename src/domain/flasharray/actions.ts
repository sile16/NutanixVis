/**
 * FlashArray actions (SPEC §5.5): `fa.io-stall`, `fa.controller.failover`, `fa.ndu`,
 * `fa.interface.disable` / `enable` (one FA IP), and `vm.snapshot` (an array task through the
 * mgmt API; SPEC §14 contract backlog). Precondition failures surface as `action.rejected`.
 */
import {
  type ActionContext,
  type ActionDefinition,
  ActionError,
  type ActionTarget,
  isLinkView,
} from '../../engine/actions';
import type { DeviceView } from '../../engine/types';
import { type FaEnv, FaModelError, type FlashArrayModel } from './model';

function actionEnv(ctx: ActionContext): FaEnv {
  return {
    now: ctx.now,
    emit: (e) => ctx.emit(e),
    setEndpointUp: (id, up) => ctx.net.setEndpointUp(id, up),
    moveEndpoint: (id, nic) => {
      ctx.net.moveEndpoint(id, { kind: 'nic', id: nic });
    },
  };
}

const device = (t: ActionTarget): DeviceView | null => (isLinkView(t) ? null : t);
const kindIs =
  (kind: string, pred: (d: DeviceView) => boolean = () => true) =>
  (t: ActionTarget): boolean => {
    const d = device(t);
    return d !== null && d.kind === kind && pred(d);
  };

export function faActions(model: FlashArrayModel): ActionDefinition[] {
  /** Run a model transition; model precondition errors become `action.rejected`. */
  const run = (ctx: ActionContext, fn: (env: FaEnv) => void): void => {
    model.observe(ctx.now);
    try {
      fn(actionEnv(ctx));
    } catch (err) {
      if (err instanceof FaModelError) throw new ActionError(err.message);
      throw err;
    }
  };
  const setEnabled =
    (on: boolean): ActionDefinition['apply'] =>
    (req, ctx) =>
      run(ctx, (env) => model.setInterfaceEnabled(req.target, on, env, ctx.causeIds));
  return [
    {
      spec: {
        kind: 'fa.io-stall',
        label: 'Stall IO on the primary',
        description:
          'The primary stops completing IO without crashing. After the IO delay timeout it gives back and the secondary promotes.',
        appliesTo: kindIs(
          'fa-controller',
          (d) => d.fields.role === 'primary' && d.fields.state === 'up',
        ),
      },
      apply: (req, ctx) => run(ctx, (env) => model.stall(req.target, env, ctx.causeIds)),
    },
    {
      spec: {
        kind: 'fa.controller.failover',
        label: 'Planned controller failover',
        description: 'Giveback and promotion with a short array-wide IO pause.',
        appliesTo: (t) =>
          kindIs('fa-array', (d) => d.fields.ioServing === true && d.fields.ndu === null)(t) ||
          kindIs('fa-controller', (d) => d.fields.role === 'primary' && d.fields.state === 'up')(t),
      },
      apply: (_req, ctx) => run(ctx, (env) => model.plannedFailover(env, ctx.causeIds)),
    },
    {
      spec: {
        kind: 'fa.ndu',
        label: 'Purity upgrade (NDU)',
        description:
          'Reboot the secondary, fail over, then reboot the old primary. A rebooting controller’s ports disappear.',
        appliesTo: kindIs('fa-array', (d) => d.fields.ioServing === true && d.fields.ndu === null),
      },
      apply: (_req, ctx) => run(ctx, (env) => model.startNdu(env, ctx.causeIds)),
    },
    {
      spec: {
        kind: 'fa.interface.disable',
        label: 'Disable FA interface',
        description: 'Take this FlashArray IP down (its NVMe connections are closed).',
        appliesTo: kindIs('fa-interface', (d) => d.fields.enabled === true),
      },
      apply: setEnabled(false),
    },
    {
      spec: {
        kind: 'fa.interface.enable',
        label: 'Enable FA interface',
        appliesTo: kindIs('fa-interface', (d) => d.fields.enabled === false),
      },
      apply: setEnabled(true),
    },
    {
      spec: {
        kind: 'vm.snapshot',
        label: 'Take array snapshot',
        description:
          'An array snapshot through the FlashArray management API. Fails if the API is unreachable; running IO is unaffected.',
        appliesTo: kindIs('vm'),
      },
      apply: (req, ctx) => {
        model.observe(ctx.now);
        model.snapshotRequests.push({ vm: req.target, at: ctx.now, causes: ctx.causeIds });
      },
    },
  ];
}
