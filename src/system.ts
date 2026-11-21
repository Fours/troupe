import { Cell, type CellHost, type CellNode, type ParentNode } from './cell.js';
import { Dispatcher } from './dispatcher.js';
import { ActorSystemTerminatedError, NotAChildError } from './errors.js';
import { EventBus } from './events.js';
import { consoleLogger, isLogger, safeLogger } from './logger.js';
import { childPath, Names } from './names.js';
import { realScheduler, type Scheduler } from './scheduler.js';
import type {
  ActorDef,
  ActorRef,
  ActorSystem,
  ActorSystemOptions,
  AnyRef,
  SpawnOptions,
} from './types.js';

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
  const cells = new WeakMap<object, CellNode>();
  let busy = 0;
  let terminating = false;
  let resolveTerminated!: () => void;
  const whenTerminated = new Promise<void>((resolve) => {
    resolveTerminated = resolve;
  });

  // The parent of every top-level actor. terminate() stops it like any other parent.
  const guardian: ParentNode = {
    path: USER_PATH,
    names: new Names(),
    childCells: new Map<string, CellNode>(),
    removeChild(child) {
      this.childCells.delete(child.name);
      this.names.release(child.name);
      // The last stopped event is published right after this returns, before anyone awaiting
      // whenTerminated can run.
      if (terminating && this.childCells.size === 0) resolveTerminated();
    },
  };

  const host: CellHost = {
    dispatcher: new Dispatcher(scheduler, throughput, yieldAfter),
    events,
    log,
    now,
    trackBusy: (delta) => {
      busy += delta;
    },
    terminating: () => terminating,
    cellOf: (ref) => (typeof ref === 'object' && ref !== null ? cells.get(ref) : undefined),
    spawn<M, S>(
      parent: ParentNode,
      def: ActorDef<M, S>,
      childName: string | undefined,
      spawnOpts: SpawnOptions | undefined,
    ): ActorRef<M> {
      if (terminating) {
        throw new ActorSystemTerminatedError(`system "${name}" is terminating, so it can't spawn`);
      }
      checkDef(def);
      const capacity = checkSpawnOptions(spawnOpts);
      const claimed = parent.names.claim(childName, parent.path);
      const path = childPath(parent.path, claimed);
      const cell = new Cell(claimed, path, def, host, capacity, parent, new Names());
      cells.set(cell.ref, cell);
      parent.childCells.set(claimed, cell);
      events.publish({ type: 'spawned', path });
      cell.start();
      return cell.ref;
    },
  };

  const system: ActorSystem = Object.freeze({
    name,
    events,
    whenTerminated,
    spawn<M, S>(def: ActorDef<M, S>, childName?: string, spawnOpts?: SpawnOptions): ActorRef<M> {
      return host.spawn(guardian, def, childName, spawnOpts);
    },
    stop(ref: AnyRef): void {
      const cell = host.cellOf(ref);
      if (cell?.parent !== guardian) {
        throw new NotAChildError(`${describeRef(ref)} is not a top-level actor of "${name}"`);
      }
      cell.requestStop();
    },
    terminate(): Promise<void> {
      if (terminating) return whenTerminated;
      terminating = true;
      if (guardian.childCells.size === 0) resolveTerminated();
      for (const child of [...guardian.childCells.values()]) child.requestStop();
      return whenTerminated;
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
  if (d.onSignal !== undefined && typeof d.onSignal !== 'function') {
    throw new TypeError('spawn: onSignal must be a function when it is set');
  }
}

function describeRef(ref: unknown): string {
  const path = typeof ref === 'object' && ref !== null ? (ref as { path?: unknown }).path : ref;
  return typeof path === 'string' ? path : 'that ref';
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
