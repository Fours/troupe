import { Cell, type CellHost } from './cell.js';
import { Dispatcher } from './dispatcher.js';
import { EventBus } from './events.js';
import { consoleLogger, isLogger, safeLogger } from './logger.js';
import { childPath, Names } from './names.js';
import { realScheduler, type Scheduler } from './scheduler.js';
import type { ActorDef, ActorRef, ActorSystem, ActorSystemOptions, SpawnOptions } from './types.js';

const SYSTEM_OPTIONS = new Set(['name', 'scheduler', 'logger', 'throughput', 'yieldAfter']);
const SPAWN_OPTIONS = new Set(['mailbox']);
const MAILBOX_OPTIONS = new Set(['capacity']);
const SYSTEM_NAME = /^[a-z0-9-]+$/;
const USER_PATH = '/user';

/** The parts of a system that the testkit needs and the public API hides. */
export interface SystemHandle {
  readonly system: ActorSystem;
  /** How many actors are waiting for an async `receive` to settle. */
  busy(): number;
}

/**
 * Creates an actor system, the root of an actor hierarchy.
 * @throws TypeError for options that can't be used, unknown fields included.
 */
export function createActorSystem(opts?: ActorSystemOptions): ActorSystem {
  return createSystem(opts).system;
}

/** {@link createActorSystem}, plus the internals the testkit reads. Not exported publicly. */
export function createSystem(opts: ActorSystemOptions = {}): SystemHandle {
  checkKeys(opts, SYSTEM_OPTIONS, 'createActorSystem');
  const {
    name = 'troupe',
    scheduler = realScheduler(),
    logger = consoleLogger('warn'),
    throughput = 10,
    yieldAfter = 1000,
  } = opts;
  if (typeof name !== 'string' || !SYSTEM_NAME.test(name)) {
    throw new TypeError(
      `createActorSystem: name must be lower-case letters, digits and "-", got ${describe(name)}`,
    );
  }
  if (!isScheduler(scheduler)) {
    throw new TypeError('createActorSystem: scheduler must have now, runSoon and setTimer methods');
  }
  if (!isLogger(logger)) {
    throw new TypeError('createActorSystem: logger must have debug, info, warn and error methods');
  }
  checkPositiveInt(throughput, 'createActorSystem: throughput');
  checkPositiveInt(yieldAfter, 'createActorSystem: yieldAfter');

  const log = safeLogger(logger);
  const now = () => scheduler.now();
  const events = new EventBus(now, log);
  let busy = 0;
  const host: CellHost = {
    dispatcher: new Dispatcher(scheduler, throughput, yieldAfter),
    events,
    log,
    now,
    trackBusy: (delta) => {
      busy += delta;
    },
  };
  const userNames = new Names();

  const system: ActorSystem = Object.freeze({
    name,
    events,
    spawn<M, S>(def: ActorDef<M, S>, childName?: string, spawnOpts?: SpawnOptions): ActorRef<M> {
      checkDef(def);
      const capacity = checkSpawnOptions(spawnOpts);
      const path = childPath(USER_PATH, userNames.claim(childName, USER_PATH));
      const cell = new Cell(path, def, host, capacity);
      events.publish({ type: 'spawned', path });
      cell.start();
      return cell.ref;
    },
  });
  return { system, busy: () => busy };
}

function checkDef(def: unknown): void {
  if (typeof def !== 'object' || def === null) {
    throw new TypeError('spawn: the definition must be an object from actor()');
  }
  const d = def as Record<string, unknown>;
  if (!('initial' in d)) throw new TypeError('spawn: the definition has no initial state');
  if (typeof d.receive !== 'function') throw new TypeError('spawn: receive must be a function');
}

function checkSpawnOptions(opts: unknown): number {
  if (opts === undefined) return Infinity;
  checkKeys(opts, SPAWN_OPTIONS, 'spawn');
  const { mailbox } = opts as SpawnOptions;
  if (mailbox === undefined) return Infinity;
  checkKeys(mailbox, MAILBOX_OPTIONS, 'spawn: mailbox');
  if (mailbox.capacity === undefined) return Infinity;
  checkPositiveInt(mailbox.capacity, 'spawn: mailbox.capacity');
  return mailbox.capacity;
}

function checkKeys(opts: unknown, allowed: ReadonlySet<string>, where: string): void {
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
    throw new TypeError(`${where}: options must be an object`);
  }
  for (const key of Object.keys(opts)) {
    if (!allowed.has(key)) throw new TypeError(`${where}: unknown option "${key}"`);
  }
}

function checkPositiveInt(value: unknown, what: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${what} must be a positive integer, got ${describe(value)}`);
  }
}

function isScheduler(value: unknown): value is Scheduler {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.now === 'function' &&
    typeof v.runSoon === 'function' &&
    typeof v.setTimer === 'function'
  );
}

function describe(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}
