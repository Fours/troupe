// One macrotask, cheaply (decision 0033). Rehearsal's run loop yields after each round of ready
// work, so the promise continuations that work started finish before simulation time moves: every
// microtask runs before the next macrotask. setTimeout(0) waits at least a millisecond in Node and
// four in nested browser calls, and setImmediate is Node-only (0004). A MessageChannel's message
// is unclamped everywhere: 0.4 µs a yield in Node and 1.3 µs in Chromium, against 1.1 and 4.5 ms.

/** Yields one macrotask at a time, on one channel, until it's closed. */
export interface Yielder {
  /** Resolves on the next macrotask, once every microtask queued before it has run. */
  next(): Promise<void>;
  /** Closes the channel. An open port would keep a Node process alive. */
  close(): void;
}

/** Opens a channel to yield on. One channel serves every yield, which is eight times cheaper. */
export function openYielder(): Yielder {
  const channel = new MessageChannel();
  const waiting: (() => void)[] = [];
  channel.port1.addEventListener('message', () => {
    waiting.shift()?.();
  });
  channel.port1.start();
  return {
    next: () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve);
        channel.port2.postMessage(null);
      }),
    close: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
}
