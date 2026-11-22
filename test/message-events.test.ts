import { afterEach, describe, expect, it, vi } from 'vitest';
import { actor } from '../src/actor.js';
import { EventBus } from '../src/events.js';
import { persistentActor } from '../src/persistence/actor.js';
import { inMemoryPersistence } from '../src/persistence/memory.js';
import { projection } from '../src/persistence/projection.js';
import { supervise } from '../src/supervision.js';
import { createTestKit, type TestKit } from '../src/testkit/kit.js';
import type { ActorRef, AnyRef, SystemEvent } from '../src/types.js';
import { account, type Receipt } from './helpers/account.js';
import { deferred } from './helpers/deferred.js';

type Delivered = Extract<SystemEvent, { type: 'delivered' }>;
type Processed = Extract<SystemEvent, { type: 'processed' }>;
type DeadLetter = Extract<SystemEvent, { type: 'deadLetter' }>;

/** Every event, message events included, as a subscriber with `{ messages: true }` sees them. */
function withMessages(kit: TestKit): SystemEvent[] {
  const seen: SystemEvent[] = [];
  kit.system.events.subscribe((e) => seen.push(e), { messages: true });
  return seen;
}

function delivered(events: readonly SystemEvent[], path?: string): Delivered[] {
  return events.filter(
    (e): e is Delivered => e.type === 'delivered' && (path === undefined || e.path === path),
  );
}

function processed(events: readonly SystemEvent[], path?: string): Processed[] {
  return events.filter(
    (e): e is Processed => e.type === 'processed' && (path === undefined || e.path === path),
  );
}

/** Checks that every `delivered` ended exactly once, and returns the event that ended each. */
function endings(events: readonly SystemEvent[]): Map<number, SystemEvent> {
  const ends = new Map<number, SystemEvent>();
  for (const e of events) {
    const id =
      e.type === 'processed' ? e.id : e.type === 'deadLetter' && 'id' in e ? e.id : undefined;
    if (id === undefined) continue;
    expect(ends.has(id), `message ${String(id)} ended twice`).toBe(false);
    ends.set(id, e);
  }
  const ids = delivered(events).map((d) => d.id);
  expect([...ends.keys()].sort((a, b) => a - b)).toEqual(ids);
  return ends;
}

/** Accepts anything and keeps nothing: a recipient that's a real actor, so it gets `delivered`. */
const sink = actor<unknown, null>({ initial: null, receive: (s) => s });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('message events', () => {
  it('gives every mailbox message a delivered and a processed, with matching ids and depths', async () => {
    const kit = createTestKit();
    const seen = withMessages(kit);
    const ref = kit.system.spawn(sink, 'sink');
    for (const n of [1, 2, 3, 4]) ref.tell(n);
    await kit.settle();

    expect(delivered(seen)).toEqual(
      [1, 2, 3, 4].map((n) => ({
        type: 'delivered',
        path: '/user/sink',
        id: n,
        message: n,
        depth: n,
        seq: expect.any(Number) as number,
        at: 0,
      })),
    );
    expect(processed(seen)).toEqual(
      [1, 2, 3, 4].map((n) => ({
        type: 'processed',
        path: '/user/sink',
        id: n,
        durationMs: 0,
        depth: 4 - n,
        stateChanged: false,
        seq: expect.any(Number) as number,
        at: 0,
      })),
    );
    // The burst all arrived before the actor's first turn.
    expect(seen.map((e) => e.type)).toEqual([
      'spawned',
      ...Array<string>(4).fill('delivered'),
      ...Array<string>(4).fill('processed'),
    ]);
    endings(seen);
  });

  it('gives timer and pipeToSelf messages events too, and none to signals or initial', async () => {
    const kit = createTestKit();
    const seen = withMessages(kit);
    const watched = kit.system.spawn(sink, 'watched');
    kit.system.spawn(
      actor<string, null>({
        initial: (ctx) => {
          ctx.timers.startSingle('t', 'tick', 10);
          ctx.pipeToSelf(Promise.resolve(1), () => 'piped');
          ctx.watch(watched);
          return null;
        },
        receive: (s) => s,
        onSignal: (s) => s,
      }),
      'busy',
    );
    await kit.settle();
    kit.system.stop(watched);
    await kit.advance(10);

    expect(delivered(seen, '/user/busy').map((d) => d.message)).toEqual([
      { ok: true, value: 1 },
      'tick',
    ]);
    expect(processed(seen, '/user/busy')).toHaveLength(2);
    endings(seen);
  });

  it('measures the time from taking a message to settling, and the depth when it came out', async () => {
    const kit = createTestKit();
    const seen = withMessages(kit);
    const gate = deferred();
    const ref = kit.system.spawn(
      actor<string, number>({
        initial: 0,
        receive: async (n, msg) => {
          if (msg === 'slow') await gate.promise;
          return n + 1;
        },
      }),
      'slow',
    );
    ref.tell('slow');
    // Runs the dispatcher without waiting for the held handler, as settle would.
    kit.scheduler.runReady();
    ref.tell('fast');
    kit.scheduler.advanceTo(30);
    gate.resolve();
    await kit.settle();
    const [first, second] = processed(seen);
    expect(first).toMatchObject({ durationMs: 30, depth: 0, stateChanged: true });
    expect(second).toMatchObject({ durationMs: 0, depth: 0, stateChanged: true });
    expect(delivered(seen)[1]).toMatchObject({ message: 'fast', depth: 1 });
  });

  it('sets stateChanged only when the handler returns a different object', async () => {
    const kit = createTestKit();
    const seen = withMessages(kit);
    const same = { n: 0 };
    const ref = kit.system.spawn(
      actor<'keep' | 'copy' | 'async-keep', { n: number }>({
        initial: same,
        receive: (s, msg) => {
          if (msg === 'copy') return { ...s };
          if (msg === 'async-keep') return Promise.resolve(s);
          return s;
        },
      }),
    );
    ref.tell('keep');
    ref.tell('copy');
    ref.tell('keep');
    ref.tell('async-keep');
    await kit.settle();
    expect(processed(seen).map((p) => p.stateChanged)).toEqual([false, true, false, false]);
  });

  it('goes only to subscribers that ask, and shares seq, so others see gaps', async () => {
    const kit = createTestKit();
    const plain: SystemEvent[] = [];
    kit.system.events.subscribe((e) => plain.push(e));
    const seen = withMessages(kit);
    const ref = kit.system.spawn(sink, 'sink');
    ref.tell('a');
    await kit.settle();
    kit.system.stop(ref);
    await kit.settle();

    expect(plain.map((e) => e.type)).toEqual(['spawned', 'stopped']);
    expect(plain.map((e) => e.seq)).toEqual([1, 4]);
    expect(seen.map((e) => [e.seq, e.type])).toEqual([
      [1, 'spawned'],
      [2, 'delivered'],
      [3, 'processed'],
      [4, 'stopped'],
    ]);
    expect(kit.events.some((e) => e.type === 'delivered' || e.type === 'processed')).toBe(false);
  });

  it('builds none while no subscriber wants them, and stops building them on the last unsubscribe', async () => {
    const publishMessage = vi.spyOn(EventBus.prototype, 'publishMessage');
    const nextMessageId = vi.spyOn(EventBus.prototype, 'nextMessageId');
    const kit = createTestKit();
    const ref = kit.system.spawn(sink, 'sink');
    ref.tell('before');
    await kit.settle();
    expect(publishMessage).not.toHaveBeenCalled();
    expect(nextMessageId).not.toHaveBeenCalled();

    const seen: SystemEvent[] = [];
    const off = kit.system.events.subscribe((e) => seen.push(e), { messages: true });
    ref.tell('during');
    await kit.settle();
    expect(delivered(seen).map((d) => d.message)).toEqual(['during']);
    off();

    publishMessage.mockClear();
    nextMessageId.mockClear();
    ref.tell('after');
    await kit.settle();
    expect(publishMessage).not.toHaveBeenCalled();
    expect(nextMessageId).not.toHaveBeenCalled();
    // With no gaps: nothing took a seq for the plain subscriber not to see.
    const seqs = kit.events.map((e) => e.seq);
    expect(seqs.slice(1).every((s, i) => s > (seqs[i] ?? 0))).toBe(true);
  });

  it('gives no processed for a message delivered before anyone asked', async () => {
    const kit = createTestKit();
    const ref = kit.system.spawn(sink, 'sink');
    ref.tell('untracked');
    const seen = withMessages(kit);
    ref.tell('tracked');
    await kit.settle();
    expect(delivered(seen).map((d) => d.message)).toEqual(['tracked']);
    expect(processed(seen)).toHaveLength(1);
    endings(seen);
  });

  it('checks its options where they are passed in', () => {
    const kit = createTestKit();
    const listen = () => {};
    expect(() => kit.system.events.subscribe(listen, { message: true } as never)).toThrow(
      /unknown option "message"/,
    );
    expect(() => kit.system.events.subscribe(listen, { messages: 'yes' } as never)).toThrow(
      /messages must be a boolean, got "yes"/,
    );
    expect(() => kit.system.events.subscribe(listen, null as never)).toThrow(TypeError);
    expect(() => kit.system.events.subscribe(listen, { messages: false })).not.toThrow();
  });

  it('treats each subscription of the same listener separately', async () => {
    const kit = createTestKit();
    const seen: string[] = [];
    const listen = (e: SystemEvent) => seen.push(e.type);
    const offPlain = kit.system.events.subscribe(listen);
    kit.system.events.subscribe(listen, { messages: true });
    offPlain();
    const ref = kit.system.spawn(sink, 'sink');
    ref.tell('a');
    await kit.settle();
    expect(seen).toEqual(['spawned', 'delivered', 'processed']);
  });
});

describe('the sender', () => {
  it('is the actor whose initial, receive or onSignal sent the message', async () => {
    const kit = createTestKit();
    const seen = withMessages(kit);
    const target = kit.system.spawn(sink, 'target');
    let doomed: AnyRef | undefined;
    const sender = kit.system.spawn(
      actor<string, null>({
        initial: (ctx) => {
          target.tell('from initial');
          doomed = ctx.spawn(sink, 'doomed');
          ctx.watch(doomed);
          return null;
        },
        receive: (s, _msg, ctx) => {
          target.tell('from receive');
          if (doomed !== undefined) ctx.stop(doomed);
          return s;
        },
        onSignal: (s, signal) => {
          if (signal.type === 'terminated') target.tell('from onSignal');
          return s;
        },
      }),
      'sender',
    );
    sender.tell('go');
    await kit.settle();

    expect(delivered(seen, '/user/target').map((d) => [d.message, d.from])).toEqual([
      ['from initial', '/user/sender'],
      ['from receive', '/user/sender'],
      ['from onSignal', '/user/sender'],
    ]);
  });

  it('is the actor for a postStop or preRestart that follows an async failure', async () => {
    const kit = createTestKit();
    const seen = withMessages(kit);
    const target = kit.system.spawn(sink, 'target');
    const ref = kit.system.spawn(
      actor<'fail', null>({
        initial: null,
        receive: async () => {
          await Promise.resolve();
          throw new Error('async failure');
        },
        onSignal: (s, signal) => {
          target.tell(signal.type);
          return s;
        },
      }),
      'failing',
      { supervision: supervise.restart() },
    );
    ref.tell('fail');
    await kit.settle();
    kit.system.stop(ref);
    await kit.settle();
    expect(delivered(seen, '/user/target').map((d) => [d.message, d.from])).toEqual([
      ['preRestart', '/user/failing'],
      ['postStop', '/user/failing'],
    ]);
  });

  it("is the projection for what its handle tells, until the handle's own await", async () => {
    const kit = createTestKit();
    const seen = withMessages(kit);
    const persistence = inMemoryPersistence({ clock: () => 0 });
    await persistence.journal.append('a', 0, [
      { event: 'one', version: 1, tags: ['sale'] },
      { event: 'two', version: 1, tags: ['sale'] },
    ]);
    const target = kit.system.spawn(sink, 'target');
    kit.system.spawn(
      projection({
        name: 'feed',
        persistence,
        tag: 'sale',
        // The read awaits the journal, so the handle runs outside the projection's turn.
        handle: async (stored) => {
          target.tell(stored.event);
          await Promise.resolve();
          target.tell(`after ${String(stored.event)}`);
        },
      }),
      'feed',
    );
    await kit.settle();
    expect(delivered(seen, '/user/target').map((d) => [d.message, d.from])).toEqual([
      ['one', '/user/feed'],
      ['after one', undefined],
      ['two', '/user/feed'],
      ['after two', undefined],
    ]);
  });

  it('is absent after an await, from outside any actor, and from a timer', async () => {
    const kit = createTestKit();
    const seen = withMessages(kit);
    const target = kit.system.spawn(sink, 'target');
    const ref = kit.system.spawn(
      actor<string, null>({
        initial: (ctx) => {
          ctx.timers.startSingle('t', 'timer', 5);
          return null;
        },
        receive: async (s, msg) => {
          if (msg === 'timer') return s;
          target.tell('before await');
          await Promise.resolve();
          target.tell('after await');
          return s;
        },
      }),
      'async',
    );
    target.tell('from outside');
    ref.tell('go');
    await kit.advance(5);

    expect(delivered(seen, '/user/target').map((d) => [d.message, d.from])).toEqual([
      ['from outside', undefined],
      ['before await', '/user/async'],
      ['after await', undefined],
    ]);
    const timer = delivered(seen, '/user/async').find((d) => d.message === 'timer');
    expect(timer).toBeDefined();
    expect(timer && 'from' in timer).toBe(false);
  });

  it("is the actor that asks, for an ask's request", async () => {
    const kit = createTestKit();
    const seen = withMessages(kit);
    const answer = kit.system.spawn(
      actor<{ replyTo: ActorRef<number> }, null>({
        initial: null,
        receive: (s, msg) => {
          msg.replyTo.tell(42);
          return s;
        },
      }),
      'answer',
    );
    const asker = kit.system.spawn(
      actor<'ask' | number, null>({
        initial: null,
        receive: (s, msg, ctx) => {
          if (msg === 'ask') {
            ctx.pipeToSelf(
              answer.ask<number>((replyTo) => ({ replyTo })),
              (r) => (r.ok ? r.value : -1),
            );
          }
          return s;
        },
      }),
      'asker',
    );
    asker.tell('ask');
    await kit.settle();
    expect(delivered(seen, '/user/answer')[0]?.from).toBe('/user/asker');
    // The reply goes to a temporary ref, which isn't an actor, so it has no delivered.
    expect(delivered(seen).some((d) => d.path.startsWith('/temp'))).toBe(false);
    // A piped ask's result is queued the moment the reply is told (decision 0010), so it names
    // the actor that replied.
    expect(delivered(seen, '/user/asker').map((d) => [d.message, d.from])).toEqual([
      ['ask', undefined],
      [{ ok: true, value: 42 }, '/user/answer'],
    ]);
  });

  it('is the persistent actor for its thenReply and recoveryCompleted tells', async () => {
    const kit = createTestKit();
    const seen = withMessages(kit);
    const persistence = inMemoryPersistence();
    const replies = kit.system.spawn(sink, 'replies') as ActorRef<Receipt>;
    const acc = kit.system.spawn(account(persistence), 'account');
    acc.tell({ type: 'deposit', amount: 5, replyTo: replies });
    acc.tell({ type: 'balance', replyTo: replies as unknown as ActorRef<number> });
    await kit.settle();
    expect(delivered(seen, '/user/replies').map((d) => [d.message, d.from])).toEqual([
      [{ ok: true, balance: 5 }, '/user/account'],
      [5, '/user/account'],
    ]);

    const announced = kit.system.spawn(sink, 'announced');
    kit.system.spawn(
      persistentActor<never, never, null>({
        id: 'announcer',
        persistence,
        initial: null,
        onCommand: (_s, _c, { none }) => none(),
        onEvent: (s) => s,
        onSignal: (_s, signal) => {
          if (signal.type === 'recoveryCompleted') {
            announced.tell(`recovered at ${String(signal.seq)}`);
          }
        },
      }),
      'announcer',
    );
    await kit.settle();
    expect(delivered(seen, '/user/announced').map((d) => [d.message, d.from])).toEqual([
      ['recovered at 0', '/user/announcer'],
    ]);
  });
});

describe('every delivered ends exactly once', () => {
  it('with a processed before the failed, when the handler throws or rejects', async () => {
    const kit = createTestKit();
    const seen = withMessages(kit);
    const ref = kit.system.spawn(
      actor<'throw' | 'reject' | 'pipe', null>({
        initial: null,
        receive: (s, msg, ctx) => {
          if (msg === 'throw') throw new Error('sync');
          if (msg === 'reject') return Promise.reject(new Error('async'));
          ctx.pipeToSelf(Promise.resolve(1), () => {
            throw new Error('mapper');
          });
          return s;
        },
      }),
      'faulty',
      { supervision: supervise.resume() },
    );
    ref.tell('throw');
    ref.tell('reject');
    ref.tell('pipe');
    await kit.settle();

    const ends = endings(seen);
    const failed = seen.filter((e) => e.type === 'failed');
    expect(failed).toHaveLength(3);
    for (const f of failed) {
      const before = seen[seen.indexOf(f) - 1];
      expect(before).toMatchObject({ type: 'processed', stateChanged: false });
    }
    expect(ends.size).toBe(4);
  });

  it('with a deadLetter carrying its id, when a stop drains it', async () => {
    const kit = createTestKit();
    const seen = withMessages(kit);
    const ref = kit.system.spawn(sink, 'sink');
    await kit.settle();
    ref.tell('a');
    ref.tell('b');
    kit.system.stop(ref);
    await kit.settle();
    ref.tell('too late');

    const ends = endings(seen);
    const [a, b] = delivered(seen);
    expect(ends.get(a?.id ?? -1)).toMatchObject({
      type: 'deadLetter',
      message: 'a',
      reason: 'stopped',
      id: a?.id,
    });
    expect(ends.get(b?.id ?? -1)).toMatchObject({ type: 'deadLetter', message: 'b' });
    // A message that never got in has no delivered, and its dead letter no id.
    const late = seen.find(
      (e): e is DeadLetter => e.type === 'deadLetter' && e.message === 'too late',
    );
    expect(late).toBeDefined();
    expect(late && 'id' in late).toBe(false);
  });

  it("with a skipped processed for a cancelled timer's message, taken or drained", async () => {
    const kit = createTestKit();
    const seen = withMessages(kit);
    let gate = deferred();
    const ref = kit.system.spawn(
      actor<'arm' | 'hold' | 'cancel' | 'tick', null>({
        initial: null,
        receive: async (s, msg, ctx) => {
          if (msg === 'arm') ctx.timers.startSingle('t', 'tick', 10);
          if (msg === 'hold') await gate.promise;
          if (msg === 'cancel') ctx.timers.cancel('t');
          return s;
        },
      }),
      'timed',
    );
    ref.tell('arm');
    await kit.settle();
    // Taken: the cancel is ahead of the timer's message in the mailbox, so the message is skipped.
    ref.tell('hold');
    ref.tell('cancel');
    kit.scheduler.runReady();
    kit.scheduler.advanceTo(10);
    gate.resolve();
    await kit.settle();
    const taken = processed(seen).filter((p) => p.skipped === true);
    expect(taken).toEqual([
      expect.objectContaining({ durationMs: 0, depth: 0, stateChanged: false, skipped: true }),
    ]);
    expect(delivered(seen).find((d) => d.id === taken[0]?.id)?.message).toBe('tick');
    // A message that was handled has no skipped field at all.
    expect(processed(seen).filter((p) => 'skipped' in p)).toHaveLength(1);

    // Drained: a stop cancels the timer while its message waits behind a held one.
    gate = deferred();
    ref.tell('arm');
    await kit.settle();
    ref.tell('hold');
    kit.scheduler.runReady();
    kit.scheduler.advanceTo(20);
    kit.system.stop(ref);
    gate.resolve();
    await kit.settle();
    const skipped = processed(seen).filter((p) => p.skipped === true);
    expect(skipped).toHaveLength(2);
    expect(delivered(seen).find((d) => d.id === skipped[1]?.id)?.message).toBe('tick');
    expect(seen.at(-1)).toMatchObject({ type: 'stopped', path: '/user/timed' });
    endings(seen);
  });
});
