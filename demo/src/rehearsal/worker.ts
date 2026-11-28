// The /rehearsal/ page's worker: festival night rehearsed, seed after seed, off the page's main
// thread, so the page keeps every frame however long a run takes, and the seeds run as fast as
// this core allows. One thing at a time: a request to draw a run is taken before the next seed.
import type { NetworkMode } from '@kylewillett/troupe/rehearsal';
import {
  MAX_PROBLEMS,
  Runner,
  type FromRunner,
  type Problem,
  type ToRunner,
} from './domain/runner.ts';

const runner = new Runner();
const post = (message: FromRunner): void => {
  self.postMessage(message);
};
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface Seeds {
  readonly mode: NetworkMode;
  running: boolean;
  runs: number;
  next: number;
  ms: number;
  failing: number;
  readonly problems: Problem[];
}

let seeds: Seeds | undefined;
const draws: Extract<ToRunner, { t: 'draw' }>[] = [];
let pumping = false;

const progress = (s: Seeds): void => {
  const { mode, runs, next, ms, failing, running } = s;
  post({ t: 'progress', mode, runs, next, ms, failing, problems: [...s.problems], running });
};

async function step(): Promise<void> {
  const d = draws.shift();
  if (d !== undefined) {
    try {
      post({ t: 'drawn', id: d.id, drawing: await runner.draw(d.mode, d.seed, d.plan) });
    } catch (error) {
      post({ t: 'failed', id: d.id, message: messageOf(error) });
    }
    return;
  }
  const s = seeds;
  if (s === undefined || !s.running) return;
  const started = performance.now();
  try {
    const problem = await runner.check(s.mode, s.next);
    if (problem !== undefined) {
      s.failing++;
      if (s.problems.length < MAX_PROBLEMS) s.problems.push(problem);
    }
  } catch (error) {
    s.running = false;
    post({ t: 'failed', id: undefined, message: messageOf(error) });
  }
  s.ms += performance.now() - started;
  s.runs++;
  s.next++;
  if (seeds === s) progress(s);
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (draws.length > 0 || seeds?.running === true) await step();
  } finally {
    pumping = false;
  }
}

self.onmessage = (e: MessageEvent<ToRunner>) => {
  const m = e.data;
  switch (m.t) {
    case 'start':
      seeds = {
        mode: m.mode,
        running: true,
        runs: 0,
        next: m.from,
        ms: 0,
        failing: 0,
        problems: [],
      };
      progress(seeds);
      break;
    case 'stop':
      if (seeds !== undefined) {
        seeds.running = false;
        progress(seeds);
      }
      break;
    case 'draw':
      draws.push(m);
      break;
  }
  void pump();
};
