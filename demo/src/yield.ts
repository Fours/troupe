/**
 * A `yieldToEventLoop` for the browser: resolves after one turn of the event loop, by way of a
 * `MessageChannel`. Browsers clamp nested `setTimeout(0)` to 4 ms, and a settle can take a few
 * turns at every due time, which at 4× would cost more than the frame.
 */
export function messageChannelYield(): { yieldToEventLoop: () => Promise<void>; close(): void } {
  const channel = new MessageChannel();
  const waiting: (() => void)[] = [];
  channel.port1.onmessage = () => {
    waiting.shift()?.();
  };
  return {
    yieldToEventLoop: () =>
      new Promise((resolve) => {
        waiting.push(resolve);
        channel.port2.postMessage(null);
      }),
    close: () => {
      channel.port1.close();
    },
  };
}
