// A node's clock in a simulation (decision 0033). Every node of a run shares one simulation clock,
// a ManualScheduler that nothing in the cluster reads. Each node gets a view onto it, with its own
// rate and its own reading, so a lease timed on a holder's clock can disagree with the store's.
//
// A node clock keeps no timer queue of its own: every task and timer goes onto the simulation's
// heap, converted to simulation time. One heap orders everything every node does, by due time and
// then creation, which is what makes a run repeat exactly.

import { checkInt, checkKeys } from '../checks.js';
import type { Connection, Transport } from '../cluster/transport.js';
import type { Scheduler } from '../scheduler.js';
import type { ManualScheduler } from '../testkit/manual-scheduler.js';

/** Options for a {@link NodeClock}. */
export interface NodeClockOptions {
  /**
   * How far the clock's rate is from simulation time's, in parts per million: at 200, it reads
   * 1,000,200 ms while a million pass. An integer from -100,000 to 100,000. Default 0.
   */
  driftPpm?: number;
  /** What its `now()` reads when it's made, in ms. Default the simulation's time then. */
  startAt?: number;
}

const OPTIONS = new Set(['driftPpm', 'startAt']);
const MAX_DRIFT_PPM = 100_000;

/** A task or timer the node has been given, and whether it may still run. */
interface Item {
  readonly task: () => void;
  cancelled: boolean;
}

/** A timer: the node time it's due at, and how to take it off the simulation's heap. */
interface Timer extends Item {
  readonly due: number;
  cancelSim: () => void;
}

/**
 * One node's scheduler in a simulation: a view onto the simulation's {@link ManualScheduler} at its
 * own rate. Its `now()` is whole milliseconds and never goes backwards, and its timers fire when
 * its own clock reaches them.
 *
 * {@link NodeClock.pause} stops the node's process, as a long GC or a suspended VM does: none of its
 * tasks or timers run, though its clock keeps going. {@link NodeClock.resume} then runs everything
 * that fell due meanwhile, in the order it fell due, before anything new.
 */
export class NodeClock implements Scheduler {
  readonly #sim: ManualScheduler;
  #simStart: number;
  #nodeStart: number;
  #rate: number;
  // Timers not yet fired, so a change of rate can put each back at its node time.
  readonly #timers = new Set<Timer>();
  #paused = false;
  // What fell due while paused, and, until it has all run, what fell due after.
  readonly #backlog: Item[] = [];
  #flushQueued = false;

  /**
   * Makes a clock for one node on `sim`.
   * @throws TypeError for options that can't be used.
   */
  constructor(sim: ManualScheduler, opts: NodeClockOptions = {}) {
    checkKeys(opts, OPTIONS, 'NodeClock');
    const { driftPpm = 0, startAt = sim.now() } = opts;
    checkDrift(driftPpm, 'NodeClock: driftPpm');
    checkInt(startAt, 'NodeClock: startAt', { min: 0 });
    this.#sim = sim;
    this.#simStart = sim.now();
    this.#nodeStart = startAt;
    this.#rate = 1 + driftPpm / 1_000_000;
  }

  /**
   * Changes the clock's rate from now on, as a fault plan's drift does. `now()` carries on from
   * where it is, so it never goes backwards, and every timer still to fire is put back at the
   * simulation time when the clock, at its new rate, reaches it.
   * @throws TypeError unless `driftPpm` is an integer from -100,000 to 100,000.
   */
  setDrift(driftPpm: number): void {
    checkDrift(driftPpm, 'NodeClock.setDrift: driftPpm');
    const now = this.now();
    this.#simStart = this.#sim.now();
    this.#nodeStart = now;
    this.#rate = 1 + driftPpm / 1_000_000;
    for (const timer of this.#timers) {
      timer.cancelSim();
      this.#schedule(timer);
    }
  }

  /** The node's own time, in whole ms. */
  now(): number {
    return this.#at(this.#sim.now());
  }

  /** Whether the node is paused. */
  get paused(): boolean {
    return this.#paused;
  }

  /** Queues `task` on the simulation, to run as this node's. */
  runSoon(task: () => void): void {
    const item: Item = { task, cancelled: false };
    this.#sim.runSoon(() => {
      this.#fire(item);
    });
  }

  /**
   * Runs `task` once this node's clock has moved `delayMs` on: at the first whole millisecond of
   * simulation time when `now()` reads at least that. A negative or `NaN` delay counts as 0.
   */
  setTimer(task: () => void, delayMs: number): () => void {
    const delay = Number.isNaN(delayMs) ? 0 : Math.max(0, delayMs);
    const timer: Timer = { task, cancelled: false, due: this.now() + delay, cancelSim: () => {} };
    this.#timers.add(timer);
    this.#schedule(timer);
    return () => {
      timer.cancelled = true;
      this.#timers.delete(timer);
      timer.cancelSim();
    };
  }

  /** Stops the node's process. Its clock keeps going. Pausing a paused node does nothing. */
  pause(): void {
    this.#paused = true;
  }

  /**
   * Lets the node run again: what fell due while it was paused runs on the simulation's next turn,
   * in order, before anything that falls due later. Resuming a running node does nothing.
   */
  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    this.#queueFlush();
  }

  #schedule(timer: Timer): void {
    timer.cancelSim = this.#sim.setTimer(() => {
      this.#timers.delete(timer);
      this.#fire(timer);
    }, this.#simDelay(timer.due));
  }

  // Runs an item now, unless the node is paused or still has a backlog to run first.
  #fire(item: Item): void {
    if (item.cancelled) return;
    if (this.#paused || this.#backlog.length > 0) {
      this.#backlog.push(item);
      return;
    }
    item.task();
  }

  #queueFlush(): void {
    if (this.#flushQueued || this.#backlog.length === 0) return;
    this.#flushQueued = true;
    this.#sim.runSoon(this.#flush);
  }

  readonly #flush = (): void => {
    this.#flushQueued = false;
    // One at a time, so a task that throws leaves the rest queued for the next turn.
    while (!this.#paused) {
      const item = this.#backlog.shift();
      if (item === undefined) return;
      if (item.cancelled) continue;
      try {
        item.task();
      } catch (error) {
        this.#queueFlush();
        throw error;
      }
    }
  };

  // The node's reading at simulation time `sim`.
  #at(sim: number): number {
    return this.#nodeStart + Math.floor((sim - this.#simStart) * this.#rate);
  }

  // How long from now in simulation time, in whole ms, until this node's clock reads `target`.
  #simDelay(target: number): number {
    const now = this.#sim.now();
    let delay = Math.max(
      0,
      Math.ceil((target - this.#nodeStart) / this.#rate + this.#simStart - now),
    );
    // The division can land a millisecond either side of the first one that reaches `target`.
    while (this.#at(now + delay) < target) delay++;
    while (delay > 0 && this.#at(now + delay - 1) >= target) delay--;
    return delay;
  }
}

function checkDrift(driftPpm: number, what: string): void {
  checkInt(driftPpm, what, { min: -MAX_DRIFT_PPM });
  if (driftPpm > MAX_DRIFT_PPM) {
    throw new TypeError(
      `${what} must be at most ${String(MAX_DRIFT_PPM)}, got ${String(driftPpm)}`,
    );
  }
}

/**
 * Wraps `transport` so that everything it hands its node, from new connections and frames to
 * closes and refusals, arrives through the node's `clock`. While the node is paused, its frames
 * wait at its sockets and it can't answer anyone, and when it resumes they arrive in order.
 */
export function throughClock(transport: Transport, clock: Scheduler): Transport {
  // Listens on the real connection at once, as a socket buffers what arrives before anyone reads,
  // so frames that come while a new connection waits for a paused node aren't lost.
  const wrap = (connection: Connection): Connection => {
    const frameListeners: ((frame: string) => void)[] = [];
    const closeListeners: ((error?: unknown) => void)[] = [];
    let closed: unknown[] | undefined;
    connection.onFrame((frame) => {
      clock.runSoon(() => {
        for (const listener of frameListeners) listener(frame);
      });
    });
    connection.onClose((...args: unknown[]) => {
      clock.runSoon(() => {
        closed = args;
        for (const listener of closeListeners.splice(0)) listener(...args);
      });
    });
    return {
      send: (frame) => {
        connection.send(frame);
      },
      onFrame: (listener) => {
        frameListeners.push(listener);
      },
      onClose: (listener) => {
        const args = closed;
        if (args === undefined) closeListeners.push(listener);
        else
          clock.runSoon(() => {
            listener(...args);
          });
      },
      close: () => {
        connection.close();
      },
    };
  };
  return {
    address: transport.address,
    listen: (onConnection, onRefused) =>
      transport.listen(
        (connection) => {
          const wrapped = wrap(connection);
          clock.runSoon(() => {
            onConnection(wrapped);
          });
        },
        onRefused === undefined
          ? undefined
          : (reason) => {
              clock.runSoon(() => {
                onRefused(reason);
              });
            },
      ),
    connect: (address) => wrap(transport.connect(address)),
    close: () => transport.close(),
  };
}
