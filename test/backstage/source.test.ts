import { describe, expect, it } from 'vitest';
import { actor } from '../../src/actor.js';
import { backstage } from '../../src/backstage/source.js';
import type { Frame, WireEvent } from '../../src/backstage/types.js';
import { inMemoryPersistence } from '../../src/persistence/memory.js';
import { supervise } from '../../src/supervision.js';
import { createTestKit, type TestKit } from '../../src/testkit/kit.js';
import type { ActorRef } from '../../src/types.js';
import { account } from '../helpers/account.js';

type Msg = { type: 'ping'; replyTo: ActorRef<string> } | { type: 'crash' };

/** An actor that answers pings and throws on `crash`. */
const pinger = actor<Msg, number>({
  initial: 0,
  receive(n, msg) {
    if (msg.type === 'crash') throw new RangeError('bad request');
    msg.replyTo.tell('pong');
    return n + 1;
  },
});

/** A parent with one child, so the tree has depth. */
const parent = actor<never, null>({
  initial(ctx) {
    ctx.spawn(pinger, 'child');
    return null;
  },
  receive: (s) => s,
});

function recorder() {
  const frames: Frame[] = [];
  const listener = (frame: Frame) => {
    frames.push(frame);
  };
  const events = (): WireEvent[] => frames.flatMap((f) => (f.type === 'event' ? [f.event] : []));
  return { frames, listener, events };
}

/** The bus's own flag for whether anyone wants message events (decision 0020). */
const messagesOn = (kit: TestKit) =>
  (kit.system.events as unknown as { readonly messages: boolean }).messages;

describe('backstage', () => {
  it('sends a hello with every live actor and the history at once, then each event', async () => {
    const kit = createTestKit({ system: { name: 'box-office' } });
    const source = backstage(kit.system);
    kit.system.spawn(parent, 'parent');
    const ref = kit.system.spawn(pinger, 'pinger');
    kit.system.spawn(account(inMemoryPersistence()), 'account');
    await kit.settle();

    const { frames, listener, events } = recorder();
    source.connect(listener);
    // At once: before any more work runs.
    expect(frames).toHaveLength(1);
    expect(frames[0]).toStrictEqual({
      type: 'hello',
      protocol: 1,
      system: 'box-office',
      now: 0,
      actors: [
        { path: '/user/parent', status: 'running', depth: 0 },
        { path: '/user/parent/child', status: 'running', depth: 0 },
        { path: '/user/pinger', status: 'running', depth: 0 },
        { path: '/user/account', status: 'running', depth: 0, persistenceId: 'account-1' },
      ],
      history: kit.events
        .filter((e) => e.type === 'spawned' || e.type === 'recovered')
        .map((e) => ({ ...e })),
    });

    const before = kit.events.length;
    const probe = kit.probe<string>('reply');
    ref.tell({ type: 'ping', replyTo: probe.ref });
    await kit.advance(5);
    // Every event the system published since, in order, with message events among them.
    const lifecycle = events().filter((e) => e.type !== 'delivered' && e.type !== 'processed');
    expect(lifecycle).toStrictEqual(kit.events.slice(before).map((e) => ({ ...e })));
    const seqs = events().map((e) => e.seq);
    expect(seqs).toStrictEqual([...seqs].sort((a, b) => a - b));
    expect(events().map((e) => e.type)).toEqual(['delivered', 'processed']);
    expect(events()[0]).toMatchObject({
      path: '/user/pinger',
      message: { type: 'ping', replyTo: { $ref: '/temp/probe-reply' } },
      depth: 1,
    });
    expect(probe.messages()).toEqual(['pong']);
  });

  it('shows a crash to a connection made after it, and keeps at most `history` events', async () => {
    const kit = createTestKit();
    const source = backstage(kit.system, { history: 4 });
    const ref = kit.system.spawn(pinger, 'pinger', {
      supervision: supervise.restartWithBackoff({ minMs: 200, maxMs: 1000, randomFactor: 0 }),
    });
    await kit.settle();
    ref.tell({ type: 'crash' });
    await kit.advance(200);

    const { frames, listener } = recorder();
    source.connect(listener);
    const hello = frames[0];
    if (hello?.type !== 'hello') throw new Error('no hello');
    expect(hello.history.map((e) => e.type)).toEqual(['spawned', 'failed', 'restarted']);
    expect(hello.history[1]).toMatchObject({
      path: '/user/pinger',
      error: { $error: { name: 'RangeError', message: 'bad request' } },
      directive: 'restart',
    });
    expect(hello.history[2]).toMatchObject({ attempt: 1, delayMs: 200 });

    // Two more lifecycle events push the oldest out. Message events never go in.
    kit.system.spawn(pinger, 'b');
    kit.system.spawn(pinger, 'c');
    ref.tell({ type: 'ping', replyTo: kit.probe<string>().ref });
    await kit.settle();
    const later = recorder();
    source.connect(later.listener);
    const second = later.frames[0];
    if (second?.type !== 'hello') throw new Error('no hello');
    expect(second.history.map((e) => e.type)).toEqual([
      'failed',
      'restarted',
      'spawned',
      'spawned',
    ]);

    const none = backstage(kit.system, { history: 0 });
    kit.system.spawn(pinger, 'd');
    const empty = recorder();
    none.connect(empty.listener);
    expect(empty.frames[0]).toMatchObject({ type: 'hello', history: [] });
  });

  it('keeps only events from after it attached, and defaults to 500 of them', async () => {
    const kit = createTestKit();
    kit.system.spawn(pinger, 'early');
    const source = backstage(kit.system);
    for (let i = 0; i < 510; i++) kit.system.spawn(pinger, `p${String(i)}`);
    await kit.settle();
    const { frames, listener } = recorder();
    source.connect(listener);
    const hello = frames[0];
    if (hello?.type !== 'hello') throw new Error('no hello');
    expect(hello.history).toHaveLength(500);
    expect(hello.history[0]).toMatchObject({ type: 'spawned', path: '/user/p10' });
    expect(hello.history.at(-1)).toMatchObject({ type: 'spawned', path: '/user/p509' });
  });

  it('logs a connection that throws, and carries on with the others', async () => {
    const kit = createTestKit();
    const source = backstage(kit.system);
    const { listener, events } = recorder();
    let calls = 0;
    source.connect(() => {
      calls += 1;
      throw new Error('broken UI');
    });
    source.connect(listener);
    kit.system.spawn(pinger, 'pinger');
    await kit.settle();
    expect(calls).toBe(2); // the hello, and the spawn
    expect(events().map((e) => e.type)).toEqual(['spawned']);
    expect(kit.logs.filter((l) => l.msg.includes('Backstage'))).toHaveLength(2);
  });

  it('stops sending to a connection that ends, and ending twice does nothing', async () => {
    const kit = createTestKit();
    const source = backstage(kit.system);
    const a = recorder();
    const b = recorder();
    const end = source.connect(a.listener);
    source.connect(b.listener);
    end();
    end();
    kit.system.spawn(pinger, 'pinger');
    await kit.settle();
    expect(a.events()).toEqual([]);
    expect(b.events()).toHaveLength(1);
  });

  it('turns message events on while attached, and close turns them off and ends every connection', async () => {
    const kit = createTestKit();
    expect(messagesOn(kit)).toBe(false);
    const source = backstage(kit.system);
    expect(messagesOn(kit)).toBe(true);
    const a = recorder();
    source.connect(a.listener);

    source.close();
    source.close();
    expect(messagesOn(kit)).toBe(false);
    kit.system.spawn(pinger, 'pinger');
    await kit.settle();
    expect(a.frames.map((f) => f.type)).toEqual(['hello']);
    expect(() => source.connect(() => {})).toThrow(/closed/);
    expect(await source.request({ type: 'state', path: '/user/pinger' })).toStrictEqual({
      ok: false,
      error: { name: 'ClosedError', message: 'the source is closed' },
    });

    // Another subscriber that wants messages keeps them on.
    const other = kit.system.events.subscribe(() => {}, { messages: true });
    const second = backstage(kit.system);
    second.close();
    expect(messagesOn(kit)).toBe(true);
    other();
    expect(messagesOn(kit)).toBe(false);
  });

  it('checks its arguments when they are passed in', () => {
    const kit = createTestKit();
    expect(() => backstage({ ...kit.system })).toThrow(TypeError);
    expect(() => backstage(kit.system, { history: -1 })).toThrow(TypeError);
    expect(() => backstage(kit.system, { history: 1.5 })).toThrow(TypeError);
    expect(() => backstage(kit.system, { size: 1 } as never)).toThrow(/unknown option "size"/);
    expect(() => backstage(kit.system, null as never)).toThrow(TypeError);
    const source = backstage(kit.system);
    expect(() => source.connect('nope' as never)).toThrow(TypeError);
  });
});
