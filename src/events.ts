import { checkKeys, describe } from './checks.js';
import type { Logger } from './logger.js';
import type { EventStream, SystemEvent } from './types.js';

type Untimed<E> = E extends unknown ? Omit<E, 'seq' | 'at'> : never;

/** An event before the bus stamps it with `seq` and `at`. */
export type EventBody = Untimed<SystemEvent>;

/** The bodies of message events, which go only to listeners that asked for them (decision 0020). */
export type MessageEventBody = Extract<EventBody, { type: 'delivered' | 'processed' }>;

type Listener = (event: SystemEvent) => void;

/** One subscription. An object, so subscribing the same function twice gives two of them. */
interface Entry {
  readonly listener: Listener;
}

const SUBSCRIBE_OPTIONS = new Set(['messages']);

/**
 * Delivers system events to listeners, synchronously and in order, so the order a listener sees
 * is the order things happened (decision 0003).
 *
 * Message events go only to listeners that subscribed with `{ messages: true }`. Cells check
 * {@link EventBus.messages} before building one, so while no listener wants them they cost one
 * check per message (decision 0020). Every event takes the next `seq`, whoever receives it.
 */
export class EventBus implements EventStream {
  // Copy on write, so a listener that unsubscribes during delivery doesn't skip its neighbour.
  #listeners: Entry[] = [];
  #messageListeners: Entry[] = [];
  #seq = 0;
  #messageId = 0;
  readonly #now: () => number;
  readonly #log: Logger;
  readonly #onMessages: (on: boolean) => void;

  /** @param onMessages Called whenever {@link EventBus.messages} changes. */
  constructor(now: () => number, log: Logger, onMessages: (on: boolean) => void = () => {}) {
    this.#now = now;
    this.#log = log;
    this.#onMessages = onMessages;
  }

  /**
   * True while at least one listener wants message events. A plain field rather than a getter,
   * since every message reads it (decision 0020). Only the bus writes it.
   */
  messages = false;

  subscribe(listener: Listener, opts?: { messages?: boolean }): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('events.subscribe: listener must be a function');
    }
    const messages = checkSubscribeOptions(opts);
    const entry: Entry = { listener };
    this.#listeners = [...this.#listeners, entry];
    if (messages) {
      this.#messageListeners = [...this.#messageListeners, entry];
      this.#setMessages(true);
    }
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== entry);
      if (messages) {
        this.#messageListeners = this.#messageListeners.filter((l) => l !== entry);
        this.#setMessages(this.#messageListeners.length > 0);
      }
    };
  }

  #setMessages(on: boolean): void {
    if (this.messages === on) return;
    this.messages = on;
    this.#onMessages(on);
  }

  /** The id for the next message that gets a `delivered`. */
  nextMessageId(): number {
    return ++this.#messageId;
  }

  publish(body: EventBody): void {
    this.#deliver(this.#listeners, body);
  }

  /** Publishes a message event to the listeners that asked for them. */
  publishMessage(body: MessageEventBody): void {
    this.#deliver(this.#messageListeners, body);
  }

  #deliver(entries: readonly Entry[], body: EventBody): void {
    const event = { ...body, seq: ++this.#seq, at: this.#now() } as SystemEvent;
    for (const entry of entries) {
      try {
        entry.listener(event);
      } catch (error) {
        this.#log.error('an event listener threw; skipped it', { error, event: event.type });
      }
    }
  }
}

function checkSubscribeOptions(opts: unknown): boolean {
  if (opts === undefined) return false;
  checkKeys(opts, SUBSCRIBE_OPTIONS, 'events.subscribe');
  const { messages } = opts as { messages?: unknown };
  if (messages !== undefined && typeof messages !== 'boolean') {
    throw new TypeError(`events.subscribe: messages must be a boolean, got ${describe(messages)}`);
  }
  return messages === true;
}
