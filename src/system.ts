import { Asker } from './ask.js';
import { Cell, type CellHost, type CellNode, type ParentNode } from './cell.js';
import { checkInt, checkKeys, describe } from './checks.js';
import { Dispatcher } from './dispatcher.js';
import { ActorSystemTerminatedError, NotAChildError } from './errors.js';
import { EventBus, type EventBody } from './events.js';
import {
  HOOKS,
  INSPECT,
  type CellInspection,
  type ClusterInspection,
  type SystemHooks,
  type SystemInspection,
  type Watcher,
  type WatchTarget,
} from './internal.js';
import { consoleLogger, isLogger, safeLogger } from './logger.js';
import { childPath, Names } from './names.js';
import { realScheduler, type Scheduler } from './scheduler.js';
import { checkStrategy, supervise, type SupervisorStrategy } from './supervision.js';
import type {
  ActorDef,
  ActorRef,
  ActorSystem,
  ActorSystemOptions,
  AnyRef,
  DeadLetterReason,
  SpawnOptions,
} from './types.js';

const SYSTEM_OPTIONS = new Set([
  'name',
  'scheduler',
  'random',
  'logger',
  'askTimeoutMs',
  'throughput',
  'yieldAfter',
]);
const SPAWN_OPTIONS = new Set(['mailbox', 'supervision']);
const STOP = supervise.stop();
const MAILBOX_OPTIONS = new Set(['capacity']);
const SYSTEM_NAME = /^[a-z0-9-]+$/;
const USER_PATH = '/user';
const SYSTEM_PATH = '/system';
const TEMP_PATH = '/temp';

/** The parts of a system that the testkit needs and the public API hides. */
export interface SystemHandle {
  readonly system: ActorSystem;
  /**
   * How many async handlers and `pipeToSelf` promises are still waiting to settle. A piped ask
   * isn't counted, because the scheduler completes it (decision 0010).
   */
  busy(): number;
  /** How many asks are waiting for a reply or their timeout. */
  pendingAsks(): number;
  /** Makes a ref whose `ask` works like any actor's, for probes. */
  readonly makeRef: <M>(path: string, tell: (msg: M) => void) => ActorRef<M>;
  /**
   * Watches `ref` for a probe, as `ctx.watch` does for an actor: `watcher` is told once, when the
   * actor terminates, or at once if it already has.
   * @throws TypeError if `ref` isn't an actor of this system.
   */
  watch(ref: AnyRef, watcher: Watcher): void;
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
    // The one place the core draws on real chance (decision 0003).
    // eslint-disable-next-line no-restricted-properties
    random = Math.random,
    logger = consoleLogger('warn'),
    askTimeoutMs = 5000,
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
  if (typeof random !== 'function') {
    throw new TypeError(`createActorSystem: random must be a function, got ${describe(random)}`);
  }
  if (!isLogger(logger)) {
    throw new TypeError('createActorSystem: logger must have debug, info, warn and error methods');
  }
  checkInt(askTimeoutMs, 'createActorSystem: askTimeoutMs');
  checkInt(throughput, 'createActorSystem: throughput');
  checkInt(yieldAfter, 'createActorSystem: yieldAfter');

  const log = safeLogger(logger);
  const now = () => scheduler.now();
  const dispatcher = new Dispatcher(scheduler, throughput, yieldAfter);
  const events = new EventBus(now, log, (on) => {
    dispatcher.trackCurrent = on;
  });
  const setTimer = (task: () => void, delayMs: number) => scheduler.setTimer(task, delayMs);
  const asker = new Asker({ events, systemName: name, defaultTimeoutMs: askTimeoutMs, setTimer });
  const makeRef = <M>(path: string, tell: (msg: M) => void) => asker.ref(path, tell);
  const cells = new WeakMap<object, CellNode>();
  // Remoting's, for remote refs (decision 0026). Undefined for a system with no cluster.
  let resolveWatch: ((ref: unknown) => WatchTarget | undefined) | undefined;
  const cellOf = (ref: unknown): CellNode | undefined =>
    typeof ref === 'object' && ref !== null ? cells.get(ref) : undefined;
  const watchTargetOf = (ref: unknown): WatchTarget | undefined =>
    cellOf(ref) ?? resolveWatch?.(ref);
  let busy = 0;
  let terminating = false;
  // Set once terminate() has stopped /user and every onTerminate task has settled: from then,
  // actors under /system stop and take no more messages.
  let systemStopping = false;
  const terminateTasks: (() => Promise<void>)[] = [];
  let tasksRun = false;
  let resolveTerminated!: () => void;
  const whenTerminated = new Promise<void>((resolve) => {
    resolveTerminated = resolve;
  });

  // The parents of every top-level actor: the user's, and the system's own under /system, which
  // the cluster uses (decision 0025). terminate() stops /user first, then /system, so a user
  // actor's last messages can still go through the cluster.
  const guardian = guardianAt(USER_PATH, () => {
    if (terminating) stopSystemActors();
  });
  const systemGuardian = guardianAt(SYSTEM_PATH, () => {
    if (terminating) checkTerminated();
  });
  // The last stopped event is published right after a removeChild returns, before anyone
  // awaiting whenTerminated can run.
  const checkTerminated = (): void => {
    if (!systemStopping) return;
    if (guardian.childCells.size === 0 && systemGuardian.childCells.size === 0) {
      resolveTerminated();
    }
  };
  // Once /user is empty, the onTerminate tasks run, such as the cluster's graceful leave, which
  // hands shards off while /system still works. Only then does /system stop.
  const stopSystemActors = (): void => {
    if (guardian.childCells.size > 0 || tasksRun) return;
    tasksRun = true;
    const stopSystem = (): void => {
      systemStopping = true;
      if (systemGuardian.childCells.size === 0) resolveTerminated();
      for (const child of [...systemGuardian.childCells.values()]) child.requestStop();
    };
    if (terminateTasks.length === 0) {
      stopSystem();
      return;
    }
    const running = terminateTasks.map(async (task) => {
      try {
        await task();
      } catch (error) {
        log.error('terminate: a termination task failed', { error });
      }
    });
    void Promise.all(running).then(stopSystem);
  };
  const isSystemPath = (path: string): boolean =>
    path === SYSTEM_PATH || path.startsWith(`${SYSTEM_PATH}/`);

  const host: CellHost = {
    dispatcher,
    events,
    log,
    senderOverride: undefined,
    now,
    random,
    setTimer,
    makeRef,
    onAskSettled: (promise, listener) => asker.onSettled(promise, listener),
    trackBusy: (delta) => {
      busy += delta;
    },
    terminating: (path) => terminating && (systemStopping || !isSystemPath(path)),
    cellOf,
    watchTargetOf,
    spawn<M, S>(
      parent: ParentNode,
      def: ActorDef<M, S>,
      childName: string | undefined,
      spawnOpts: SpawnOptions | undefined,
    ): ActorRef<M> {
      if (terminating && (systemStopping || !isSystemPath(parent.path))) {
        throw new ActorSystemTerminatedError(`system "${name}" is terminating, so it can't spawn`);
      }
      checkDef(def);
      const { capacity, supervision } = checkSpawnOptions(spawnOpts);
      const claimed = parent.names.claim(childName, parent.path);
      const path = childPath(parent.path, claimed);
      const cell = new Cell(claimed, path, def, host, { capacity, supervision }, parent);
      cells.set(cell.ref, cell);
      parent.childCells.set(claimed, cell);
      events.publish({ type: 'spawned', path });
      cell.start();
      return cell.ref;
    },
  };

  let clusterView: ClusterInspection | undefined;
  const clusterListeners = new Set<() => void>();
  const inspection: SystemInspection = Object.freeze({
    scheduler,
    log,
    walk: () => {
      const out = walk(guardian.childCells, []);
      const sharding = systemGuardian.childCells.get('sharding');
      return sharding === undefined ? out : walk(sharding.childCells, out);
    },
    cluster: () => clusterView,
    onClusterChange(listener: () => void) {
      // A wrapper per call, so adding one listener twice gives two subscriptions.
      const own = () => {
        listener();
      };
      clusterListeners.add(own);
      return () => {
        clusterListeners.delete(own);
      };
    },
  });

  const system: ActorSystem = {
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
      // Pending asks fail now, so an actor awaiting one in an async receive can still stop.
      asker.terminate();
      if (guardian.childCells.size === 0) stopSystemActors();
      for (const child of [...guardian.childCells.values()]) child.requestStop();
      return whenTerminated;
    },
  };
  const hooks: SystemHooks = Object.freeze({
    scheduler,
    random,
    log,
    spawnSystem<M, S>(
      def: ActorDef<M, S>,
      childName?: string,
      spawnOpts?: SpawnOptions,
      parent?: AnyRef,
    ) {
      if (parent === undefined) return host.spawn(systemGuardian, def, childName, spawnOpts);
      const cell = cellOf(parent);
      if (cell === undefined || cell.terminated || !cell.ref.path.startsWith(`${SYSTEM_PATH}/`)) {
        throw new TypeError('spawnSystem: parent must be a live actor under /system');
      }
      return host.spawn(cell as unknown as ParentNode, def, childName, spawnOpts);
    },
    lookup(path: string): AnyRef | undefined {
      if (path.startsWith(`${TEMP_PATH}/`)) return asker.temp(path);
      const root = path.startsWith(`${USER_PATH}/`)
        ? guardian
        : path.startsWith(`${SYSTEM_PATH}/`)
          ? systemGuardian
          : undefined;
      return root === undefined ? undefined : find(root, path.slice(root.path.length + 1));
    },
    owns: (ref: unknown) => asker.owns(ref),
    makeRef,
    publish: (body: EventBody) => {
      events.publish(body);
    },
    deadLetter(recipient: string, message: unknown, reason: DeadLetterReason) {
      events.publish({ type: 'deadLetter', recipient, message, reason });
    },
    watchTarget: watchTargetOf,
    setWatchResolver(resolve: (ref: unknown) => WatchTarget | undefined) {
      if (resolveWatch !== undefined) throw new Error('a watch resolver is already installed');
      resolveWatch = resolve;
    },
    sender: () => host.senderOverride ?? dispatcher.current?.path,
    stopWhenIdle(ref: AnyRef) {
      const cell = cellOf(ref);
      if (cell === undefined)
        throw new TypeError('stopWhenIdle: the ref is not an actor of this system');
      cell.stopWhenIdle();
    },
    onTerminate(task: () => Promise<void>) {
      if (tasksRun) throw new Error('onTerminate: the system has already stopped /user');
      terminateTasks.push(task);
    },
    setCluster(view: ClusterInspection) {
      if (clusterView !== undefined) throw new Error('a cluster view is already set');
      clusterView = view;
      return () => {
        for (const listener of [...clusterListeners]) {
          try {
            listener();
          } catch (error) {
            log.error('a cluster view listener threw; skipped it', { error });
          }
        }
      };
    },
    tellFrom(ref: AnyRef, message: unknown, from: string | undefined) {
      const outer = host.senderOverride;
      host.senderOverride = from;
      try {
        (ref as ActorRef<unknown>).tell(message);
      } finally {
        host.senderOverride = outer;
      }
    },
  });
  // Not enumerable, so spreading or logging a system doesn't show them.
  Object.defineProperty(system, INSPECT, { value: inspection });
  Object.defineProperty(system, HOOKS, { value: hooks });
  Object.freeze(system);
  return {
    system,
    busy: () => busy,
    pendingAsks: () => asker.pending(),
    makeRef,
    watch(ref, watcher) {
      const target = watchTargetOf(ref);
      if (target === undefined) {
        throw new TypeError('watch: the ref is not an actor of this system');
      }
      if (target.terminated) watcher.notifyTerminated(target);
      else target.addWatcher(watcher);
    },
  };
}

/** A guardian: the parent of top-level actors at `path`. `onEmpty` runs when its last child goes. */
function guardianAt(path: string, onEmpty: () => void): ParentNode {
  return {
    path,
    names: new Names(),
    childCells: new Map<string, CellNode>(),
    removeChild(child) {
      this.childCells.delete(child.name);
      this.names.release(child.name);
      if (this.childCells.size === 0) onEmpty();
    },
  };
}

/** The ref of the cell at `relative`, a path such as `a/b` below `root`, if it hasn't terminated. */
function find(root: ParentNode, relative: string): AnyRef | undefined {
  let children: ReadonlyMap<string, CellNode> = root.childCells;
  let cell: CellNode | undefined;
  for (const name of relative.split('/')) {
    cell = children.get(name);
    if (cell === undefined) return undefined;
    children = cell.childCells;
  }
  return cell?.ref;
}

/** Every cell under `cells`, depth first, each parent before its children in spawn order. */
function walk(cells: ReadonlyMap<string, CellNode>, out: CellInspection[]): CellInspection[] {
  for (const cell of cells.values()) {
    out.push(cell.inspect());
    walk(cell.childCells, out);
  }
  return out;
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

function checkSpawnOptions(opts: unknown): {
  capacity: number;
  supervision: SupervisorStrategy;
} {
  if (opts === undefined) return { capacity: Infinity, supervision: STOP };
  checkKeys(opts, SPAWN_OPTIONS, 'spawn');
  const { mailbox, supervision = STOP } = opts as SpawnOptions;
  checkStrategy(supervision, 'spawn: supervision');
  return { capacity: checkCapacity(mailbox), supervision };
}

function checkCapacity(mailbox: SpawnOptions['mailbox']): number {
  if (mailbox === undefined) return Infinity;
  checkKeys(mailbox, MAILBOX_OPTIONS, 'spawn: mailbox');
  if (mailbox.capacity === undefined) return Infinity;
  checkInt(mailbox.capacity, 'spawn: mailbox.capacity');
  return mailbox.capacity;
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
