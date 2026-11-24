// The cluster demo, checked end to end in Docker (milestone 4, T10). It builds and starts
// docker-compose.cluster.yml, waits for the crowd to be buying at every show, kills node-2 with
// SIGKILL, and checks that each of node-2's shows answers again from another node within
// FAILOVER_DEADLINE_MS, with every sale it had acknowledged. Then it starts node-2 again and
// checks that shows move back to it. It removes the cluster at the end, pass or fail.
//
//   node scripts/cluster-smoke.ts
//
// It reads the story the narrator tells (examples/cluster/story.ts) and prints it as it goes.
import { spawn, spawnSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { parseComposeLine } from '../examples/cluster/compose.ts';
import { SHOWS } from '../examples/cluster/show.ts';
import { Story } from '../examples/cluster/story.ts';

const FILE = 'docker-compose.cluster.yml';
/** Until every show has answered, and node-2 hosts at least one, with no move for SETTLED_MS. */
const SETTLE_DEADLINE_MS = 120_000;
const SETTLED_MS = 5_000;
/** The README promises failover in about ten seconds with the default leases. */
const FAILOVER_DEADLINE_MS = 30_000;
const RETURN_DEADLINE_MS = 60_000;

function compose(...args: string[]): void {
  const result = spawnSync('docker', ['compose', '-f', FILE, ...args], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed`);
}

const story = new Story();
/** The newest timestamp read, on Docker's clock, which every deadline here is measured on. */
let now = 0;
let check: (() => void) | undefined;

function follow(): () => void {
  const child = spawn('docker', ['compose', '-f', FILE, 'logs', '-f', '-t', '--no-color'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (raw) => {
    const line = parseComposeLine(raw);
    if (line === undefined) return;
    now = Math.max(now, line.at);
    for (const sentence of story.read(line.service, line.text, line.at)) console.log(sentence);
    check?.();
  });
  return () => child.kill();
}

/** Resolves once `done` holds, checked after every line, or rejects after `ms` of wall time. */
function until(what: string, ms: number, done: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      check = undefined;
      reject(new Error(`timed out after ${String(ms)} ms waiting for ${what}`));
    }, ms);
    check = () => {
      if (!done()) return;
      check = undefined;
      clearTimeout(timer);
      resolve();
    };
    check();
  });
}

function hostedBy(node: string): string[] {
  return [...story.shows.entries()].filter(([, s]) => s.node === node).map(([show]) => show);
}

function failIfProblems(): void {
  if (story.problems.length > 0) throw new Error(story.problems.join('\n'));
}

async function main(): Promise<void> {
  compose('up', '-d', '--build', '--wait');
  const stop = follow();
  try {
    await until('every show to answer, with node-2 hosting some', SETTLE_DEADLINE_MS, () => {
      const lastMove = story.moves.at(-1)?.at ?? 0;
      return (
        story.shows.size === SHOWS.length &&
        hostedBy('node-2').length > 0 &&
        now - lastMove >= SETTLED_MS
      );
    });
    const victims = hostedBy('node-2');
    const before = new Map(victims.map((show) => [show, story.shows.get(show)?.lastSale ?? 0]));
    console.log(`\nsmoke: killing node-2, which hosts ${victims.join(', ')}\n`);
    const killedAt = now;
    compose('kill', 'node-2');

    await until(`${victims.join(', ')} to answer from another node`, FAILOVER_DEADLINE_MS, () =>
      victims.every((show) => {
        const state = story.shows.get(show);
        return state !== undefined && state.node !== 'node-2' && !state.silent;
      }),
    );
    failIfProblems();
    for (const show of victims) {
      const state = story.shows.get(show);
      if (state === undefined || state.lastSale <= (before.get(show) ?? 0)) {
        throw new Error(`${show} answered, but not past its last acknowledged sale`);
      }
    }
    const slowest = Math.max(...victims.map((show) => story.shows.get(show)?.lastAckAt ?? now));
    console.log(`\nsmoke: every show was back ${String(slowest - killedAt)} ms after the kill\n`);

    const response = await fetch('http://127.0.0.1:7071/');
    const html = await response.text();
    if (!response.ok || !html.includes('<html')) {
      throw new Error(`Backstage on node-1 answered ${String(response.status)}`);
    }
    console.log('smoke: Backstage answers on 127.0.0.1:7071\n');

    compose('start', 'node-2');
    await until(
      'a show to move back to node-2',
      RETURN_DEADLINE_MS,
      () => hostedBy('node-2').length > 0,
    );
    failIfProblems();
    console.log(`\nsmoke: node-2 hosts ${hostedBy('node-2').join(', ')} again. Passed.`);
  } finally {
    check = undefined;
    stop();
  }
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(`\nsmoke: FAILED: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  compose('down', '-v');
}
process.exit(failed ? 1 : 0);
