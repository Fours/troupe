// The globals src/ may use: the subset every JavaScript runtime provides (browsers, Node, Deno,
// Bun, edge workers). The build has no Node or DOM types (decision 0004), so anything not declared
// here fails to compile. The editor and test config excludes this file and gets these from
// @types/node instead, where a second `performance` declaration would clash.

/** A timer handle: a number in browsers, an object in Node. Only ever passed back to clearTimeout. */
type TimerHandle = unknown;

declare function setTimeout(callback: () => void, delayMs?: number): TimerHandle;
declare function clearTimeout(handle: TimerHandle): void;
declare function queueMicrotask(callback: () => void): void;

declare const performance: {
  now(): number;
};

declare const console: {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
