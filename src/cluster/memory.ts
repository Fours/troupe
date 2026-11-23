// An in-memory network: every node in one process, on one scheduler (decision 0026). Frames are
// strings, as on TCP, so the wire format runs as it would between processes. Everything happens
// on the scheduler, so a cluster on a ManualScheduler is deterministic: what the tests, the
// browser demo and milestone 5's simulation build on.

import { checkInt, checkKeys, describe } from '../checks.js';
import type { Scheduler } from '../scheduler.js';
import type { Connection, Transport } from './transport.js';

/** Options for {@link inMemoryNetwork}. */
export interface InMemoryNetworkOptions {
  /** The scheduler every delivery goes through: one per network. */
  scheduler: Scheduler;
  /** How long a frame, an open or a close takes to arrive, in ms. Default 1. */
  latencyMs?: number;
}

/** Nodes in one process, joined by connections that deliver after a fixed latency. */
export interface InMemoryNetwork {
  /**
   * A transport for the node at `address`. An address is free again once its transport has
   * closed or its node has been killed.
   * @throws Error if a live transport already has `address`.
   * @throws TypeError unless `address` is a non-empty string.
   */
  transport(address: string): Transport;
  /**
   * Kills the node at `address`, as `kill -9` would: its connections drop with no goodbye, frames
   * on their way to or from it are lost, and the other ends see their connections close with an
   * error, one latency later. Killing an address with no live node does nothing.
   */
  kill(address: string): void;
}

const OPTIONS = new Set(['scheduler', 'latencyMs']);

/** A node on the network: one transport's side of things. */
interface Host {
  readonly address: string;
  onConnection: ((connection: Connection) => void) | undefined;
  readonly ends: Set<End>;
  gone: boolean;
}

/**
 * Makes an in-memory network on `scheduler`. Every frame is delivered `latencyMs` after it's sent,
 * in order per connection.
 * @throws TypeError for options that can't be used.
 */
export function inMemoryNetwork(opts: InMemoryNetworkOptions): InMemoryNetwork {
  checkKeys(opts, OPTIONS, 'inMemoryNetwork');
  const { scheduler, latencyMs = 1 } = opts;
  const given: unknown = scheduler;
  if (typeof (given as { setTimer?: unknown } | null)?.setTimer !== 'function') {
    throw new TypeError('inMemoryNetwork: scheduler must be a Scheduler');
  }
  checkInt(latencyMs, 'inMemoryNetwork: latencyMs', { min: 0 });
  const hosts = new Map<string, Host>();
  const later = (task: () => void): void => {
    scheduler.setTimer(task, latencyMs);
  };

  const connect = (from: Host, address: string): Connection => {
    const local = new End(from, later, scheduler);
    from.ends.add(local);
    // Opening takes one latency, as frames do, so frames sent meanwhile arrive after it.
    later(() => {
      if (local.closed || from.gone) return;
      const target = hosts.get(address);
      if (target?.onConnection === undefined) {
        local.drop(new Error(`nothing listens at ${address}`));
        return;
      }
      const remote = new End(target, later, scheduler);
      target.ends.add(remote);
      local.peer = remote;
      remote.peer = local;
      target.onConnection(remote);
    });
    return local;
  };

  return {
    transport(address: string): Transport {
      if (typeof address !== 'string' || address === '') {
        throw new TypeError(
          `inMemoryNetwork: address must be a non-empty string, got ${describe(address)}`,
        );
      }
      if (hosts.has(address)) {
        throw new Error(`inMemoryNetwork: ${address} already has a live transport`);
      }
      const host: Host = { address, onConnection: undefined, ends: new Set(), gone: false };
      hosts.set(address, host);
      return {
        address,
        listen(onConnection) {
          if (host.gone) return Promise.reject(new Error(`${address} has closed`));
          if (host.onConnection !== undefined) {
            return Promise.reject(new Error(`${address} is already listening`));
          }
          host.onConnection = onConnection;
          return Promise.resolve();
        },
        connect(to: string) {
          if (host.gone) {
            const dead = new End(host, later, scheduler);
            dead.drop(new Error(`${address} has closed`));
            return dead;
          }
          return connect(host, to);
        },
        close() {
          if (!host.gone) {
            host.gone = true;
            host.onConnection = undefined;
            hosts.delete(address);
            for (const end of [...host.ends]) end.close();
          }
          return Promise.resolve();
        },
      };
    },
    kill(address: string): void {
      const host = hosts.get(address);
      if (host === undefined) return;
      host.gone = true;
      host.onConnection = undefined;
      hosts.delete(address);
      for (const end of [...host.ends]) end.vanish();
    },
  };
}

/** One end of a connection. */
class End implements Connection {
  peer: End | undefined;
  closed = false;
  readonly #host: Host;
  readonly #later: (task: () => void) => void;
  readonly #scheduler: Scheduler;
  readonly #frameListeners: ((frame: string) => void)[] = [];
  readonly #closeListeners: ((error?: unknown) => void)[] = [];
  #closeError: { readonly error?: unknown } | undefined;
  // Its node was killed, so even frames it sent before are lost.
  #vanished = false;

  constructor(host: Host, later: (task: () => void) => void, scheduler: Scheduler) {
    this.#host = host;
    this.#later = later;
    this.#scheduler = scheduler;
  }

  send(frame: string): void {
    if (this.closed) return;
    this.#later(() => {
      // Lost if this node was killed since, or the other end has closed.
      const peer = this.peer;
      if (this.#vanished || peer === undefined || peer.closed) return;
      peer.#emitFrame(frame);
    });
  }

  onFrame(listener: (frame: string) => void): void {
    this.#frameListeners.push(listener);
  }

  onClose(listener: (error?: unknown) => void): void {
    const closed = this.#closeError;
    if (closed === undefined) {
      this.#closeListeners.push(listener);
      return;
    }
    this.#scheduler.runSoon(() => {
      listener(...closeArgs(closed));
    });
  }

  close(): void {
    if (this.closed) return;
    this.finish({});
    // The other end hears of it after the frames already sent, which arrive first.
    this.#later(() => {
      this.peer?.finish({});
    });
  }

  /** Closes this end because it never opened, telling its listeners why. */
  drop(error: Error): void {
    this.finish({ error });
  }

  /** This end's node was killed: nothing is told here, and the other end hears of it as an error. */
  vanish(): void {
    this.#vanished = true;
    if (this.closed) return;
    this.closed = true;
    this.#closeError = {};
    this.#host.ends.delete(this);
    this.#frameListeners.length = 0;
    this.#closeListeners.length = 0;
    const peer = this.peer;
    this.#later(() => {
      peer?.finish({ error: new Error(`the connection to ${this.#host.address} was reset`) });
    });
  }

  #emitFrame(frame: string): void {
    for (const listener of this.#frameListeners) listener(frame);
  }

  /** Closes this end, telling its listeners on the scheduler. */
  finish(how: { readonly error?: unknown }): void {
    if (this.closed) return;
    this.closed = true;
    this.#closeError = how;
    this.#host.ends.delete(this);
    const listeners = this.#closeListeners.splice(0);
    // Told on the scheduler, never inside the call that closed it, so a listener can't re-enter.
    this.#scheduler.runSoon(() => {
      for (const listener of listeners) listener(...closeArgs(how));
    });
  }
}

function closeArgs(how: { readonly error?: unknown }): [] | [unknown] {
  return 'error' in how ? [how.error] : [];
}
