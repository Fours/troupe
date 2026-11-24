// The macrotask probe (milestone 5, T1, decision 0033). Rehearsal's run loop yields one macrotask
// after each round of ready work, so the promise continuations that work started can finish before
// simulation time moves. A run takes tens of thousands of yields, so each one must be cheap, and it
// must work in every runtime 0004 lists, since the site runs seeds in the browser.
//
// For each way of yielding, this times a chain of yields, and checks that one yield lets a deep
// chain of microtasks finish first, which is what the loop relies on. On Node it also checks that a
// process with a closed MessageChannel still exits.
//
//   node scripts/probe-macrotask.ts [--chromium] [--out file.json]
//
// --chromium runs the same probe in Playwright's Chromium instead of this Node. --out merges the
// result into a JSON file, under the runtime's name.
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import process from 'node:process';

/** What one way of yielding measured. */
interface Measured {
  /** Microseconds per yield, the median of five chains. Null when the runtime lacks it. */
  readonly usPerYield: number | null;
  /** How many yields each timed chain had. */
  readonly yields: number;
  /** Whether a 1,000-deep chain of microtasks had finished by the time one yield returned. */
  readonly drainsMicrotasks: boolean | null;
}

// Self-contained, since Playwright sends its source to the page: no imports and no closures.
async function probe(): Promise<Record<string, Measured>> {
  type Yield = () => Promise<void>;
  const g = globalThis as unknown as {
    setImmediate?: (callback: () => void) => unknown;
    MessageChannel?: typeof MessageChannel;
  };
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? NaN;
  };
  const drains = async (yieldOnce: Yield): Promise<boolean> => {
    let done = false;
    void (async () => {
      for (let i = 0; i < 1000; i++) await Promise.resolve();
      done = true;
    })();
    await yieldOnce();
    return done;
  };
  const measure = async (
    make: (() => { yieldOnce: Yield; close: () => void }) | undefined,
    yields: number,
  ): Promise<Measured> => {
    if (make === undefined) return { usPerYield: null, yields, drainsMicrotasks: null };
    const { yieldOnce, close } = make();
    try {
      for (let i = 0; i < Math.min(200, yields); i++) await yieldOnce();
      const runs: number[] = [];
      for (let run = 0; run < 5; run++) {
        const start = performance.now();
        for (let i = 0; i < yields; i++) await yieldOnce();
        runs.push(((performance.now() - start) * 1000) / yields);
      }
      return { usPerYield: median(runs), yields, drainsMicrotasks: await drains(yieldOnce) };
    } finally {
      close();
    }
  };
  const Channel = g.MessageChannel;
  const immediate = g.setImmediate;
  return {
    setTimeout: await measure(
      () => ({
        yieldOnce: () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
          }),
        close: () => {},
      }),
      // Clamped to a millisecond or more, so fewer, or this takes minutes in the browser.
      500,
    ),
    setImmediate: await measure(
      immediate === undefined
        ? undefined
        : () => ({
            yieldOnce: () =>
              new Promise<void>((resolve) => {
                immediate(resolve);
              }),
            close: () => {},
          }),
      20_000,
    ),
    messageChannelShared: await measure(
      Channel === undefined
        ? undefined
        : () => {
            const channel = new Channel();
            let pending: (() => void) | undefined;
            // addEventListener and start(), as Rehearsal's yield uses them: Node's types have no
            // onmessage on a port.
            channel.port1.addEventListener('message', () => {
              const resolve = pending;
              pending = undefined;
              resolve?.();
            });
            channel.port1.start();
            return {
              yieldOnce: () =>
                new Promise<void>((resolve) => {
                  pending = resolve;
                  channel.port2.postMessage(null);
                }),
              close: () => {
                channel.port1.close();
                channel.port2.close();
              },
            };
          },
      20_000,
    ),
    messageChannelPerYield: await measure(
      Channel === undefined
        ? undefined
        : () => ({
            yieldOnce: () =>
              new Promise<void>((resolve) => {
                const channel = new Channel();
                channel.port1.addEventListener('message', () => {
                  channel.port1.close();
                  channel.port2.close();
                  resolve();
                });
                channel.port1.start();
                channel.port2.postMessage(null);
              }),
            close: () => {},
          }),
      20_000,
    ),
  };
}

// A Node process that yields on a MessageChannel and closes it must still exit on its own.
function exitsAfterClose(): boolean {
  const code = `
    const c = new MessageChannel();
    c.port1.addEventListener('message', () => { c.port1.close(); c.port2.close(); });
    c.port1.start();
    c.port2.postMessage(null);
  `;
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt === -1 ? undefined : args[outAt + 1];
let runtime: string;
let results: Record<string, Measured>;
let extra: { messageChannelClosedExits?: boolean } = {};
if (args.includes('--chromium')) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // A real page, not about:blank, so timers clamp as they do on a site.
    await page.setContent('<!doctype html><title>probe</title>');
    runtime = `chromium ${browser.version()}`;
    results = await page.evaluate(probe);
  } finally {
    await browser.close();
  }
} else {
  runtime = `node ${process.version}`;
  results = await probe();
  extra = { messageChannelClosedExits: exitsAfterClose() };
}

const entry = { results, ...extra };
console.log(runtime, JSON.stringify(entry, null, 2));
if (out !== undefined) {
  const file: { runtimes: Record<string, unknown>; [key: string]: unknown } = existsSync(out)
    ? (JSON.parse(readFileSync(out, 'utf8')) as { runtimes: Record<string, unknown> })
    : {
        command: 'node scripts/probe-macrotask.ts [--chromium] --out <this file>',
        machine: `${os.cpus()[0]?.model ?? 'unknown'}, ${os.platform()} ${os.release()}`,
        runtimes: {},
      };
  file.runtimes[runtime] = entry;
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
}
