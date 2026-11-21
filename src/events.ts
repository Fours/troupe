import type { Logger } from './logger.js';
import type { EventStream, SystemEvent } from './types.js';

type Untimed<E> = E extends unknown ? Omit<E, 'seq' | 'at'> : never;

/** An event before the bus stamps it with `seq` and `at`. */
export type EventBody = Untimed<SystemEvent>;

/**
 * Delivers system events to listeners, synchronously and in order, so the order a listener sees
 * is the order things happened (decision 0003).
 */
export class EventBus implements EventStream {
  #listeners: ((event: SystemEvent) => void)[] = [];
  #seq = 0;
  readonly #now: () => number;
  readonly #log: Logger;

  constructor(now: () => number, log: Logger) {
    this.#now = now;
    this.#log = log;
  }

  subscribe(listener: (event: SystemEvent) => void): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('events.subscribe: listener must be a function');
    }
    // Copy on write, so a listener that unsubscribes during delivery doesn't skip its neighbour.
    this.#listeners = [...this.#listeners, listener];
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  }

  publish(body: EventBody): void {
    const event = { ...body, seq: ++this.#seq, at: this.#now() } as SystemEvent;
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#log.error('an event listener threw; skipped it', { error, event: event.type });
      }
    }
  }
}
