import { describe, expect, it } from 'vitest';
import { JournalConflictError } from '../../src/persistence/errors.js';
import type { NewEvent } from '../../src/persistence/types.js';
import { NodeClock } from '../../src/rehearsal/clock.js';
import {
  simulatedDatabase,
  type SimulatedDatabase,
  type SimulatedDatabaseOptions,
} from '../../src/rehearsal/database.js';
import { RunLoop } from '../../src/rehearsal/loop.js';
import { ManualScheduler } from '../../src/testkit/manual-scheduler.js';
import { seededRandom } from '../../src/testkit/random.js';
import { journalContract } from '../persistence/contract.js';
import { shardStoreContract } from '../cluster/shard-store-contract.js';

// Milestone 5, T3: the simulated database, on its own. Every call takes simulation time, so a test
// drives the run loop until the calls it awaits have settled.

type Options = Partial<Omit<SimulatedDatabaseOptions, 'scheduler' | 'random'>>;

function setup(opts: Options = {}, seed = 1) {
  const sim = new ManualScheduler();
  const db = simulatedDatabase({ scheduler: sim, random: seededRandom(seed), ...opts });
  const loop = new RunLoop(sim);
  return { sim, db, loop, drive: pump(loop, sim) };
}

/**
 * A driver for promises that settle on simulation time: it moves time from timer to timer while
 * any promise it was given is still waiting, one loop for all of them, so they can overlap.
 */
function pump(loop: RunLoop, sim: ManualScheduler) {
  let waiting = 0;
  let running: Promise<void> | undefined;
  const run = async (): Promise<void> => {
    while (waiting > 0) {
      await loop.settle();
      if (waiting === 0) break;
      const next = sim.nextTimerAt();
      // Nothing could settle what's left: the test will say so.
      if (next === undefined) break;
      await loop.runUntil(next);
    }
    running = undefined;
  };
  return <T>(promise: Promise<T>): Promise<T> => {
    waiting++;
    const done = (): void => {
      waiting--;
    };
    promise.then(done, done);
    running ??= run();
    return promise;
  };
}

/** Wraps every method of `target` so its promise is driven to settle. */
function driven<T extends object>(target: T, drive: <R>(p: Promise<R>) => Promise<R>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(target)) {
    if (typeof value !== 'function') continue;
    out[key] = (...args: unknown[]) =>
      drive((value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
  }
  return out as T;
}

/** Watches a promise without awaiting it, for calls that may never settle. */
function watch<T>(promise: Promise<T>) {
  const state: { settled: boolean; ok?: boolean; value?: T; error?: unknown; at?: number } = {
    settled: false,
  };
  promise.then(
    (value) => {
      Object.assign(state, { settled: true, ok: true, value });
    },
    (error: unknown) => {
      Object.assign(state, { settled: true, ok: false, error });
    },
  );
  return state;
}

/** Watches a promise, and notes the simulation time it settled at. */
function timed<T>(promise: Promise<T>, sim: ManualScheduler) {
  const state = watch(promise);
  promise.then(
    () => {
      state.at = sim.now();
    },
    () => {
      state.at = sim.now();
    },
  );
  return state;
}

const ev = (event: unknown): NewEvent => ({ event, version: 1, tags: [] });

journalContract('simulated database', {
  create({ clock }) {
    const { db, drive } = setup({ clock });
    const { persistence } = db.connect('node-1');
    return {
      journal: driven(persistence.journal, drive),
      snapshots: driven(persistence.snapshots, drive),
      offsets: driven(persistence.offsets, drive),
    };
  },
});

shardStoreContract('simulated database', {
  // Each call takes up to 6 ms there and back, well inside the contract's margins at 20.
  unitMs: 20,
  create() {
    const { db, loop, drive } = setup();
    return Promise.resolve({
      store: driven(db.connect('node-1').shards, drive),
      elapse: (ms: number) => loop.advance(ms),
    });
  },
});

describe('simulatedDatabase', () => {
  it('tells its observer what became of each call', async () => {
    const calls: unknown[] = [];
    const { db, drive, loop } = setup({ observe: (call) => calls.push(call) });
    const one = db.connect('node-1');
    await drive(one.persistence.journal.append('a', 0, [ev(1), ev(2)]));
    await drive(one.shards.acquire('show/1', 'node-1#1', 1_000));
    const stopLosing = db.loseReplies({ node: 'node-1' });
    watch(one.persistence.journal.append('a', 2, [ev(3)]));
    await loop.advance(20);
    stopLosing();
    const heal = db.cutOff('node-1');
    await drive(one.shards.renewAll('node-1#1', 1_000)).catch(() => {});
    heal();
    const pending = watch(one.persistence.journal.read('a', 1, 10));
    one.close();
    await loop.advance(20);
    expect(pending.ok).toBe(false);
    expect(calls).toEqual([
      {
        node: 'node-1',
        op: 'journal.append',
        target: 'a@0+2',
        applied: true,
        ok: true,
        reply: 'delivered',
      },
      {
        node: 'node-1',
        op: 'shards.acquire',
        target: 'show/1',
        applied: true,
        ok: true,
        reply: 'delivered',
      },
      {
        node: 'node-1',
        op: 'journal.append',
        target: 'a@2+1',
        applied: true,
        ok: true,
        reply: 'lost',
      },
      {
        node: 'node-1',
        op: 'shards.renewAll',
        target: 'node-1#1',
        applied: false,
        ok: false,
        reply: 'delivered',
      },
      // In flight when its client closed, it still landed.
      { node: 'node-1', op: 'journal.read', target: '', applied: true, ok: true, reply: 'closed' },
    ]);
    expect(() =>
      simulatedDatabase({
        scheduler: new ManualScheduler(),
        random: Math.random,
        observe: 1 as never,
      }),
    ).toThrow(/observe must be a function/);
  });

  it('tells its observer of a reply that met a cut on its way back', async () => {
    const calls: { reply: string; applied: boolean }[] = [];
    const { db, loop, sim } = setup({ observe: (call) => calls.push(call), latencyMs: [5, 5] });
    const one = db.connect('node-1');
    const call = watch(one.shards.holders('show/'));
    // Applied at 5, and cut off before its reply lands at 10.
    await loop.runUntil(7);
    expect(sim.now()).toBe(7);
    const heal = db.cutOff('node-1');
    await loop.advance(10);
    heal();
    expect(call.ok).toBe(false);
    expect(calls).toEqual([expect.objectContaining({ applied: true, reply: 'disconnected' })]);
  });

  it('takes a drawn latency for each request and each reply', async () => {
    const { sim, db, loop } = setup({ latencyMs: [5, 5] });
    const { journal } = db.connect('node-1').persistence;
    const append = timed(journal.append('a', 0, [ev(1)]), sim);
    await loop.advance(4);
    expect(db.events('a')).toEqual([]);
    await loop.advance(1);
    // Applied at 5, so the database's clock stamps it then, and answered at 10.
    expect(db.events('a').map((e) => e.timestamp)).toEqual([5]);
    expect(append.settled).toBe(false);
    await loop.advance(5);
    expect(append).toMatchObject({ settled: true, ok: true, at: 10 });
  });

  it('draws latencies within the range, so calls overtake each other, and repeats from a seed', async () => {
    const draws = async (seed: number) => {
      const { sim, db, loop } = setup({ latencyMs: [1, 10] }, seed);
      const { offsets } = db.connect('node-1').persistence;
      const calls = Array.from({ length: 50 }, (_, i) => timed(offsets.load(`p${String(i)}`), sim));
      await loop.advance(20);
      return calls.map((c) => c.at as number);
    };
    const times = await draws(1);
    expect(times.every((t) => t >= 2 && t <= 20)).toBe(true);
    expect(times.some((t, i) => i > 0 && t < (times[i - 1] as number))).toBe(true);
    expect(await draws(1)).toEqual(times);
    expect(await draws(2)).not.toEqual(times);
  });

  it('copies a call’s arguments when it’s made, and rejects bad ones at once, sending nothing', async () => {
    const { db, loop } = setup();
    const { journal, snapshots } = db.connect('node-1').persistence;
    const event = { n: 1 };
    const state = { s: 1 };
    const append = journal.append('a', 0, [ev(event)]);
    const save = snapshots.save('a', { seq: 1, version: 1, state });
    event.n = 2;
    state.s = 2;
    await loop.advance(10);
    await append;
    await save;
    expect(db.events('a').map((e) => e.event)).toEqual([{ n: 1 }]);
    const load = snapshots.load('a');
    await loop.advance(10);
    expect((await load)?.state).toEqual({ s: 1 });

    const before = db.counts().calls;
    await expect(journal.append('', 0, [])).rejects.toThrow(TypeError);
    await expect(db.connect('node-1').shards.acquire('show/1', 'a#1', 0)).rejects.toThrow(
      TypeError,
    );
    expect(db.counts().calls).toBe(before);
  });

  it('serves the shard store on the same endpoint, judging expiry on its own clock', async () => {
    const { db, loop, drive } = setup();
    const shards = driven(db.connect('node-1').shards, drive);
    expect(await shards.acquire('show/1', 'a#1', 1_000)).toEqual({ acquired: true, token: 1 });
    await loop.advance(500);
    expect(await shards.acquire('show/1', 'b#2', 1_000)).toEqual({
      acquired: false,
      holder: 'a#1',
    });
    await loop.advance(600);
    expect(await shards.acquire('show/1', 'b#2', 1_000)).toEqual({ acquired: true, token: 2 });
  });

  describe('a slow spell', () => {
    it('draws every call’s latency from its range, or one node’s, until it ends', async () => {
      const { sim, db, loop } = setup({ latencyMs: [1, 1] });
      const one = db.connect('node-1').persistence.offsets;
      const two = db.connect('node-2').persistence.offsets;
      const end = db.slow({ latencyMs: [100, 100] });
      const a = timed(one.load('x'), sim);
      await loop.advance(300);
      expect(a.at).toBe(200);
      end();

      const endTwo = db.slow({ node: 'node-2', latencyMs: [50, 50] });
      const b = timed(one.load('x'), sim);
      const c = timed(two.load('x'), sim);
      await loop.advance(200);
      expect(b.at).toBe(sim.now() - 200 + 2);
      expect(c.at).toBe(sim.now() - 200 + 100);
      endTwo();
      const d = timed(two.load('x'), sim);
      await loop.advance(10);
      expect(d.at).toBe(sim.now() - 10 + 2);
    });

    it('never makes a call faster than the base latency', async () => {
      const { sim, db, loop } = setup({ latencyMs: [10, 10] });
      db.slow({ latencyMs: [0, 1] });
      const a = timed(db.connect('node-1').persistence.offsets.load('x'), sim);
      await loop.advance(30);
      expect(a.at).toBe(20);
    });
  });

  describe('a hang', () => {
    it('holds calls unapplied and unanswered, then applies them in the order they came', async () => {
      const { sim, db, loop } = setup({ latencyMs: [5, 5] });
      const { journal } = db.connect('node-1').persistence;
      const letGo = db.hang();
      const first = timed(journal.append('a', 0, [ev(1)]), sim);
      const second = timed(journal.append('a', 1, [ev(2)]), sim);
      await loop.advance(10_000);
      expect(db.events('a')).toEqual([]);
      expect(first.settled || second.settled).toBe(false);
      expect(db.counts().hung).toBe(2);
      letGo();
      await loop.advance(10);
      expect(db.events('a').map((e) => e.event)).toEqual([1, 2]);
      expect(first).toMatchObject({ ok: true, at: 10_005 });
      expect(second).toMatchObject({ ok: true, at: 10_005 });
    });

    it('holds only the node it’s for, and keeps what another hang still holds', async () => {
      const { sim, db, loop } = setup({ latencyMs: [5, 5] });
      const one = db.connect('node-1').persistence.offsets;
      const two = db.connect('node-2').persistence.offsets;
      const letGoAll = db.hang();
      const letGoTwo = db.hang({ node: 'node-2' });
      const a = timed(one.save('x', 1), sim);
      const b = timed(two.save('y', 1), sim);
      await loop.advance(100);
      letGoAll();
      await loop.advance(100);
      expect(a).toMatchObject({ ok: true, at: 105 });
      expect(b.settled).toBe(false);
      const c = timed(one.load('x'), sim);
      await loop.advance(10);
      expect(c).toMatchObject({ ok: true, value: 1 });
      letGoTwo();
      letGoTwo();
      await loop.advance(10);
      expect(b).toMatchObject({ ok: true, at: 215 });
    });

    it('can hang for good', async () => {
      const { sim, db, loop } = setup();
      db.hang();
      const a = timed(db.connect('node-1').shards.holders(''), sim);
      await loop.advance(1_000_000);
      expect(a.settled).toBe(false);
    });
  });

  describe('errors', () => {
    it('fail calls without applying them, for every node or one, until they end', async () => {
      const { sim, db, loop } = setup();
      const one = db.connect('node-1').persistence.journal;
      const two = db.connect('node-2').persistence.journal;
      const end = db.fail({ node: 'node-1' });
      const a = timed(one.append('a', 0, [ev(1)]), sim);
      const b = timed(two.append('b', 0, [ev(1)]), sim);
      await loop.advance(10);
      expect(a).toMatchObject({ ok: false });
      expect(String(a.error)).toBe('Error: the database failed journal.append');
      expect(b).toMatchObject({ ok: true });
      expect(db.events('a')).toEqual([]);
      end();
      const c = timed(one.append('a', 0, [ev(1)]), sim);
      await loop.advance(10);
      expect(c).toMatchObject({ ok: true });
      expect(db.counts().failed).toBe(1);
    });

    it('fail a share of calls at a rate', async () => {
      const { db, loop } = setup();
      const { offsets } = db.connect('node-1').persistence;
      db.fail({ rate: 0.5 });
      const calls = Array.from({ length: 200 }, () => watch(offsets.load('x')));
      await loop.advance(10);
      const failed = calls.filter((c) => c.ok === false).length;
      expect(failed).toBeGreaterThan(60);
      expect(failed).toBeLessThan(140);
    });
  });

  describe('a lost reply', () => {
    it('leaves an append’s events in the journal, and the caller never learns of it', async () => {
      const { sim, db, loop } = setup();
      const { journal } = db.connect('node-1').persistence;
      const end = db.loseReplies();
      const append = timed(journal.append('a', 0, [ev(1)]), sim);
      await loop.advance(100_000);
      expect(append.settled).toBe(false);
      expect(db.events('a').map((e) => e.event)).toEqual([1]);
      expect(db.counts().lostReplies).toBe(1);
      end();
      // Trying again finds out: the sequence check says the first one landed.
      const retry = timed(journal.append('a', 0, [ev(1)]), sim);
      await loop.advance(10);
      expect(retry.error).toBeInstanceOf(JournalConflictError);
      const next = timed(journal.append('a', 1, [ev(2)]), sim);
      await loop.advance(10);
      expect(next).toMatchObject({ ok: true });
      expect(db.events('a').map((e) => e.event)).toEqual([1, 2]);
    });

    it('applies a lease call whose reply it loses', async () => {
      const { db, loop, drive } = setup();
      const shards = db.connect('node-1').shards;
      db.loseReplies({ node: 'node-1', rate: 1 });
      const acquire = watch(shards.acquire('show/1', 'a#1', 10_000));
      await loop.advance(100);
      expect(acquire.settled).toBe(false);
      const other = driven(db.connect('node-2').shards, drive);
      expect(await other.holders('')).toEqual([{ lease: 'show/1', holder: 'a#1' }]);
    });
  });

  describe('a node cut off', () => {
    it('has its calls refused, unapplied, while the others carry on, until it heals', async () => {
      const { sim, db, loop } = setup();
      const one = db.connect('node-1').persistence.journal;
      const two = db.connect('node-2').persistence.journal;
      const heal = db.cutOff('node-1');
      const a = timed(one.append('a', 0, [ev(1)]), sim);
      const b = timed(two.append('b', 0, [ev(1)]), sim);
      await loop.advance(10);
      expect(String(a.error)).toBe('Error: node-1 cannot reach the database');
      expect(b).toMatchObject({ ok: true });
      expect(db.events('a')).toEqual([]);
      heal();
      const c = timed(one.append('a', 0, [ev(1)]), sim);
      await loop.advance(10);
      expect(c).toMatchObject({ ok: true });
      expect(db.counts().refused).toBe(1);
    });

    it('cuts every incarnation of the node, the next one included', async () => {
      const { sim, db, loop } = setup();
      db.cutOff('node-1');
      const later = db.connect('node-1').persistence.offsets;
      const a = timed(later.load('x'), sim);
      await loop.advance(10);
      expect(a).toMatchObject({ ok: false });
    });

    it('loses the connection for replies on their way, though the call was applied', async () => {
      const { sim, db, loop } = setup({ latencyMs: [5, 5] });
      const { journal } = db.connect('node-1').persistence;
      const append = timed(journal.append('a', 0, [ev(1)]), sim);
      await loop.advance(7);
      db.cutOff('node-1');
      await loop.advance(10);
      expect(String(append.error)).toBe("Error: node-1's connection to the database was lost");
      expect(db.events('a').map((e) => e.event)).toEqual([1]);
      expect(db.counts().disconnected).toBe(1);
    });
  });

  it('jumps its wall clock forward, so a lease expires early and events are stamped later', async () => {
    const { sim, db, loop, drive } = setup({ clock: () => 1_000_000 + sim.now() });
    const shards = driven(db.connect('node-1').shards, drive);
    const journal = driven(db.connect('node-1').persistence.journal, drive);
    await shards.acquire('show/1', 'a#1', 10_000);
    db.jump(20_000);
    expect(db.now()).toBe(1_020_000 + sim.now());
    expect(await shards.acquire('show/1', 'b#2', 10_000)).toEqual({ acquired: true, token: 2 });
    await journal.append('a', 0, [ev(1)]);
    expect(db.events('a')[0]?.timestamp).toBeGreaterThanOrEqual(1_020_000);
    await loop.advance(1);
  });

  describe('a paused caller', () => {
    it('gets its reply only when it wakes, while another node’s call completes meanwhile', async () => {
      const { sim, db, loop } = setup({ latencyMs: [5, 5] });
      const clock = new NodeClock(sim);
      const paused = db.connect('node-1', clock).persistence.journal;
      const running = db.connect('node-2', new NodeClock(sim)).persistence.journal;
      const first = timed(paused.append('a', 0, [ev(1)]), sim);
      const second = timed(paused.read('a', 1, 10), sim);
      const other = timed(running.append('b', 0, [ev(1)]), sim);
      clock.pause();
      await loop.advance(1_000);
      expect(db.events('a').map((e) => e.event)).toEqual([1]);
      expect(first.settled || second.settled).toBe(false);
      expect(other).toMatchObject({ ok: true, at: 10 });
      clock.resume();
      await loop.settle();
      expect(first).toMatchObject({ ok: true, at: 1_000 });
      expect(second).toMatchObject({ ok: true, at: 1_000 });
      expect((second.value as readonly unknown[]).length).toBe(1);
    });
  });

  describe('a closed client', () => {
    it('fails its waiting calls at once, and every later one, though what it sent still lands', async () => {
      const { sim, db, loop, drive } = setup({ latencyMs: [5, 5] });
      const client = db.connect('node-1');
      const append = timed(client.persistence.journal.append('a', 0, [ev(1)]), sim);
      await loop.advance(6);
      // The append's reply is on its way, and so is the acquire, which a hang will hold.
      const letGo = db.hang();
      const acquire = timed(client.shards.acquire('show/1', 'a#1', 10_000), sim);
      await loop.advance(1);
      client.close();
      client.close();
      await loop.settle();
      expect(String(append.error)).toBe("Error: node-1's database client has closed");
      expect(acquire).toMatchObject({ ok: false, at: 7 });
      letGo();
      await loop.advance(10);
      expect(db.events('a').map((e) => e.event)).toEqual([1]);
      expect(await driven(db.connect('node-2').shards, drive).holders('')).toEqual([
        { lease: 'show/1', holder: 'a#1' },
      ]);
      expect(db.counts().dropped).toBe(2);
      await expect(client.shards.holders('')).rejects.toThrow(
        "node-1's database client has closed",
      );
    });
  });

  describe('options', () => {
    const sim = new ManualScheduler();
    const random = seededRandom(1);
    const make = (opts: object) => () => simulatedDatabase({ scheduler: sim, random, ...opts });

    it('throw TypeError where they’re passed in', () => {
      expect(make({ latency: [1, 2] })).toThrow('simulatedDatabase: unknown option "latency"');
      expect(() => simulatedDatabase({ scheduler: {}, random } as never)).toThrow(
        'simulatedDatabase: scheduler must be a Scheduler',
      );
      expect(() => simulatedDatabase({ scheduler: sim, random: 1 } as never)).toThrow(
        'simulatedDatabase: random must be a function, got 1',
      );
      expect(make({ latencyMs: [3, 1] })).toThrow('must have min at most max');
      expect(make({ latencyMs: [-1, 1] })).toThrow(TypeError);
      expect(make({ clock: 5 })).toThrow('simulatedDatabase: clock must be a function, got 5');
    });

    it('throw TypeError for bad faults and nodes', () => {
      const db: SimulatedDatabase = make({})();
      expect(() => db.connect('')).toThrow(TypeError);
      expect(() => db.connect('node-1', {} as never)).toThrow(
        'simulatedDatabase.connect: clock must be a Scheduler',
      );
      expect(() => db.slow({ latencyMs: [2, 1] })).toThrow(TypeError);
      expect(() => db.slow({ latencyMs: [1, 2], node: '' })).toThrow(TypeError);
      expect(() => db.slow({ latencyMs: [1, 2], peer: 'x' } as never)).toThrow(
        'slow: unknown option "peer"',
      );
      expect(() => db.hang({ node: 7 } as never)).toThrow(TypeError);
      expect(() => db.hang({ ms: 7 } as never)).toThrow('hang: unknown option "ms"');
      expect(() => db.fail({ rate: 0 })).toThrow('fail: rate must be a number above 0');
      expect(() => db.loseReplies({ rate: 2 })).toThrow('loseReplies: rate must be');
      expect(() => db.cutOff('')).toThrow(TypeError);
      expect(() => {
        db.jump(0);
      }).toThrow('jump: ms must be a positive integer, got 0');
      expect(() => {
        db.jump(1.5);
      }).toThrow(TypeError);
    });

    it('read the wall clock as integer ms', async () => {
      const db = make({ clock: () => 1.5 })();
      const call = db.connect('node-1').persistence.journal.append('a', 0, [ev(1)]);
      const loop = new RunLoop(sim);
      const state = watch(call);
      await loop.advance(10);
      expect(String(state.error)).toContain('simulatedDatabase: clock() must be');
    });
  });
});
