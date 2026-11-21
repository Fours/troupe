// Public API. Export only from here and from testkit/index.ts.
export { actor } from './actor.js';
export {
  ActorNameError,
  ActorStoppedError,
  ActorSystemTerminatedError,
  NotAChildError,
} from './errors.js';
export { consoleLogger, silentLogger, type Logger, type LogLevel } from './logger.js';
export { realScheduler, type Scheduler } from './scheduler.js';
export { createActorSystem } from './system.js';
export type {
  ActorContext,
  ActorDef,
  ActorRef,
  ActorSystem,
  ActorSystemOptions,
  AnyRef,
  EventStream,
  Signal,
  SpawnOptions,
  SystemEvent,
} from './types.js';
