/** Public engine API (SPEC §4, §5). Domain modules and the UI bridge import from here. */
export {
  type ActionContext,
  type ActionDefinition,
  ActionError,
  ActionRegistry,
  type ActionTarget,
  boolParam,
  builtinActions,
  isLinkView,
  numberParam,
  optionalStringParam,
  stringParam,
} from './actions';
export { ENGINE_OWNER, type PendingTimer, TimerQueue } from './clock';
export {
  asEngineContext,
  type DerivedValue,
  type DeviceLifecycle,
  type EndpointControl,
  type EngineDevice,
  type EngineTickContext,
  type EngineTrace,
  isEngineContext,
  type TickPhase,
} from './context';
export { EventLog, eventId, eventSeq } from './events';
export { DEFAULT_DELIVERY_ROUNDS, MessageBus, TrafficRegistry } from './messaging';
export * from './network';
export { createRng, type SeededRng } from './rng';
export { createSimulation, type EngineSimulation, type SimulationOptions } from './sim';
export { buildSnapshot, deepFreeze } from './snapshot';
export type * from './types';
