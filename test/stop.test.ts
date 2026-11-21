import { describe, expect, it } from 'vitest';
import { actor } from '../src/actor.js';
import { ActorNameError, NotAChildError } from '../src/errors.js';
import { createTestKit, type TestKit } from '../src/testkit/kit.js';
import type { ActorContext, ActorRef, AnyRef } from '../src/types.js';
import { idle, tree, watcher } from './helpers/actors.js';
import { deferred } from './helpers/deferred.js';

function logEvents(kit: TestKit, log: string[]): void {
  kit.system.events.subscribe((e) => {
    if (e.type === 'stopped') log.push(`stopped ${e.path}`);
  });
}

describe('stopping order', () => {
  it('stops children depth first, awaits async postStop, then notifies watchers', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    const refs = new Map<string, AnyRef>();
    logEvents(kit, log);
    const root = kit.system.spawn(
      tree(
        {
          name: 'root',
          children: [
            { name: 'a', asyncStop: true, children: [{ name: 'a1' }, { name: 'a2' }] },
            { name: 'b' },
          ],
        },
        log,
        refs,
      ),
      'root',
    );
    const watch = kit.system.spawn(watcher(log), 'watcher');
    await kit.settle();
    const a = refs.get('/user/root/a');
    if (!a) throw new Error('a was not spawned');
    watch.tell({ watch: a });
    watch.tell({ watch: root });
    await kit.settle();

    kit.system.stop(root);
    await kit.settle();

    const at = (entry: string) => {
      const i = log.indexOf(entry);
      expect(i, entry).toBeGreaterThanOrEqual(0);
      return i;
    };
    // Each leaf runs postStop before its own stopped event.
    expect(at('a1 postStop')).toBeLessThan(at('stopped /user/root/a/a1'));
    expect(at('a2 postStop')).toBeLessThan(at('stopped /user/root/a/a2'));
    expect(at('b postStop')).toBeLessThan(at('stopped /user/root/b'));
    // a waits for both of its children, then awaits its own async postStop.
    expect(at('a postStop started')).toBeGreaterThan(at('stopped /user/root/a/a1'));
    expect(at('a postStop started')).toBeGreaterThan(at('stopped /user/root/a/a2'));
    expect(at('a postStop done')).toBeLessThan(at('stopped /user/root/a'));
    // root goes last, after every descendant.
    expect(at('root postStop')).toBeGreaterThan(at('stopped /user/root/a'));
    expect(at('root postStop')).toBeGreaterThan(at('stopped /user/root/b'));
    expect(at('root postStop')).toBeLessThan(at('stopped /user/root'));
    // Watchers hear after the stopped event, on their own turn.
    expect(at('watcher saw /user/root/a')).toBeGreaterThan(at('stopped /user/root/a'));
    expect(at('watcher saw /user/root')).toBeGreaterThan(at('stopped /user/root'));
    expect(log.filter((l) => l.startsWith('stopped'))).toHaveLength(5);
  });
});

describe('ctx.stop', () => {
  it('finishes the current message, then dead-letters the rest and anything sent later', async () => {
    const kit = createTestKit();
    const seen: string[] = [];
    const ref = kit.system.spawn(
      actor<string, null>({
        initial: null,
        receive: (s, msg, ctx) => {
          if (msg === 'stop') ctx.stop();
          seen.push(msg);
          return s;
        },
      }),
      'stopper',
    );
    ref.tell('one');
    ref.tell('stop');
    ref.tell('queued');
    await kit.settle();
    ref.tell('later');
    await kit.settle();
    expect(seen).toEqual(['one', 'stop']);
    expect(
      kit.events.filter((e) => e.type === 'deadLetter').map((e) => [e.message, e.reason]),
    ).toEqual([
      ['queued', 'stopped'],
      ['later', 'stopped'],
    ]);
  });

  it('stops after an async receive settles, not during it', async () => {
    const kit = createTestKit();
    const seen: string[] = [];
    const ref = kit.system.spawn(
      actor<string, null>({
        initial: null,
        receive: async (s, msg, ctx) => {
          ctx.stop();
          await Promise.resolve();
          seen.push(`${msg} done`);
          return s;
        },
      }),
    );
    ref.tell('work');
    ref.tell('never');
    await kit.settle();
    expect(seen).toEqual(['work done']);
  });

  it("jumps a child's queued messages", async () => {
    // throughput 1: the child takes one message per turn, so the parent's stop request lands
    // while the rest are still queued.
    const kit = createTestKit({ system: { throughput: 1 } });
    const seen: number[] = [];
    let child: ActorRef<number> | undefined;
    const parent = kit.system.spawn(
      actor<'stop-child', null>({
        initial: (ctx) => {
          child = ctx.spawn(
            actor<number, null>({
              initial: null,
              receive: (s, n) => {
                seen.push(n);
                return s;
              },
            }),
            'child',
          );
          return null;
        },
        receive: (s, _msg, ctx) => {
          if (child) ctx.stop(child);
          return s;
        },
      }),
    );
    await kit.settle();
    // The child takes 1, then the parent's turn sends the stop, which goes ahead of 2 to 5.
    for (let i = 1; i <= 5; i++) child?.tell(i);
    parent.tell('stop-child');
    await kit.settle();
    expect(seen).toEqual([1]);
    expect(
      kit.events.filter((e) => e.type === 'deadLetter').map((e) => [e.message, e.reason]),
    ).toEqual([
      [2, 'stopped'],
      [3, 'stopped'],
      [4, 'stopped'],
      [5, 'stopped'],
    ]);
  });

  it('throws NotAChildError for a ref that is neither self nor a child', async () => {
    const kit = createTestKit();
    const errors: unknown[] = [];
    const stranger = kit.system.spawn(idle, 'stranger');
    const probe = kit.probe<never>();
    let grandchild: AnyRef | undefined;
    const parent = kit.system.spawn(
      actor<'go', null>({
        initial: (ctx) => {
          ctx.spawn(
            actor<never, null>({
              initial: (inner) => {
                grandchild = inner.spawn(idle, 'gc');
                return null;
              },
              receive: (s) => s,
            }),
            'kid',
          );
          return null;
        },
        receive: (s, _msg, ctx) => {
          for (const ref of [stranger, probe.ref, grandchild]) {
            try {
              ctx.stop(ref);
            } catch (e) {
              errors.push(e);
            }
          }
          return s;
        },
      }),
      'parent',
    );
    // Let the grandchild spawn first, so all three refs exist.
    await kit.settle();
    expect(grandchild).toBeDefined();
    parent.tell('go');
    await kit.settle();
    expect(errors).toHaveLength(3);
    for (const e of errors) expect(e).toBeInstanceOf(NotAChildError);
    expect(String(errors[0])).toMatch(/\/user\/stranger is not a child of \/user\/parent/);
  });

  it('does nothing when stopping a child that has already terminated', async () => {
    const kit = createTestKit();
    let ctx: ActorContext<never> | undefined;
    let child: AnyRef | undefined;
    kit.system.spawn(
      actor<never, null>({
        initial: (c) => {
          ctx = c;
          child = c.spawn(idle, 'kid');
          return null;
        },
        receive: (s) => s,
      }),
    );
    await kit.settle();
    ctx?.stop(child);
    await kit.settle();
    expect(() => ctx?.stop(child)).not.toThrow();
  });
});

describe('system.stop', () => {
  it('stops top-level actors only', async () => {
    const kit = createTestKit();
    let child: AnyRef | undefined;
    const top = kit.system.spawn(
      actor<never, null>({
        initial: (ctx) => {
          child = ctx.spawn(idle, 'kid');
          return null;
        },
        receive: (s) => s,
      }),
      'top',
    );
    await kit.settle();
    expect(() => {
      if (child) kit.system.stop(child);
    }).toThrow(NotAChildError);
    expect(() => {
      kit.system.stop(kit.probe<never>().ref);
    }).toThrow(NotAChildError);
    kit.system.stop(top);
    await kit.settle();
    expect(kit.events.filter((e) => e.type === 'stopped').map((e) => e.path)).toEqual([
      '/user/top/kid',
      '/user/top',
    ]);
    // Stopping it again does nothing.
    kit.system.stop(top);
  });
});

describe('names and refs after a stop', () => {
  it('frees the name only once the actor has terminated, and never reaches the new actor', async () => {
    const kit = createTestKit();
    const seen: string[] = [];
    const gate = deferred();
    const named = (label: string) =>
      actor<string, null>({
        initial: null,
        receive: (s, msg) => {
          seen.push(`${label}:${msg}`);
          return s;
        },
        onSignal: async (s, signal) => {
          if (signal.type === 'postStop') await gate.promise;
          return s;
        },
      });
    const first = kit.system.spawn(named('first'), 'svc');
    await kit.settle();
    kit.system.stop(first);
    // Run the stop up to postStop, which the gate holds open: the actor is stopping, not
    // terminated, so its name is still taken.
    kit.scheduler.runReady();
    expect(() => kit.system.spawn(named('second'), 'svc')).toThrow(ActorNameError);
    gate.resolve();
    await kit.settle();
    const second = kit.system.spawn(named('second'), 'svc');
    expect(second.path).toBe(first.path);
    expect(second).not.toBe(first);
    first.tell('to old ref');
    second.tell('to new ref');
    await kit.settle();
    expect(seen).toEqual(['second:to new ref']);
    expect(kit.events.filter((e) => e.type === 'deadLetter')).toMatchObject([
      { recipient: '/user/svc', message: 'to old ref', reason: 'stopped' },
    ]);
  });
});

describe('failures stop the actor', () => {
  it('stops on a throw in receive, with failure set, and logs it', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    const boom = new Error('boom');
    const ref = kit.system.spawn(
      actor<string, null>({
        initial: null,
        receive: (s, msg) => {
          if (msg === 'bad') throw boom;
          return s;
        },
      }),
      'fragile',
    );
    kit.system.spawn(watcher(log), 'w').tell({ watch: ref });
    await kit.settle();
    ref.tell('bad');
    ref.tell('after');
    await kit.settle();
    expect(kit.events.find((e) => e.type === 'stopped')).toMatchObject({
      path: '/user/fragile',
      failure: boom,
    });
    expect(log).toEqual(['watcher saw /user/fragile fail: Error: boom']);
    expect(kit.events.filter((e) => e.type === 'deadLetter')).toMatchObject([
      { message: 'after', reason: 'stopped' },
    ]);
    expect(kit.logs).toMatchObject([
      {
        level: 'error',
        msg: 'actor failed',
        fields: { message: 'bad', error: boom, directive: 'stop' },
      },
    ]);
  });

  it('stops on a rejection from an async receive', async () => {
    const kit = createTestKit();
    const ref = kit.system.spawn(
      actor<string, null>({
        initial: null,
        receive: async () => {
          await Promise.resolve();
          throw new Error('async boom');
        },
      }),
    );
    ref.tell('go');
    await kit.settle();
    expect(kit.events.find((e) => e.type === 'stopped')).toMatchObject({
      failure: new Error('async boom'),
    });
  });

  it('stops on a throw in initial, without running postStop', async () => {
    const kit = createTestKit();
    let postStops = 0;
    const ref = kit.system.spawn(
      actor<string, number>({
        initial: () => {
          throw new Error('no start');
        },
        receive: (n) => n,
        onSignal: (n) => {
          postStops++;
          return n;
        },
      }),
    );
    ref.tell('a');
    await kit.settle();
    expect(postStops).toBe(0);
    expect(kit.events.find((e) => e.type === 'stopped')).toMatchObject({
      failure: new Error('no start'),
    });
    expect(kit.events.filter((e) => e.type === 'deadLetter')).toMatchObject([
      { message: 'a', reason: 'stopped' },
    ]);
  });

  it('counts a thrown value that is not an Error, even undefined', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    const ref = kit.system.spawn(
      actor<string, null>({
        initial: null,
        receive: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point of the test
          throw undefined;
        },
      }),
      'odd',
    );
    kit.system.spawn(watcher(log)).tell({ watch: ref });
    await kit.settle();
    ref.tell('go');
    await kit.settle();
    const stopped = kit.events.find((e) => e.type === 'stopped');
    expect(stopped && 'failure' in stopped).toBe(true);
    expect(log).toEqual(['watcher saw /user/odd fail: undefined']);
  });

  it('logs a throw or rejection in postStop, and stops anyway', async () => {
    const kit = createTestKit();
    const sync = kit.system.spawn(
      actor<never, null>({
        initial: null,
        receive: (s) => s,
        onSignal: () => {
          throw new Error('sync postStop');
        },
      }),
      'sync',
    );
    const asyncRef = kit.system.spawn(
      actor<never, null>({
        initial: null,
        receive: (s) => s,
        onSignal: () => Promise.reject(new Error('async postStop')),
      }),
      'async',
    );
    await kit.settle();
    kit.system.stop(sync);
    kit.system.stop(asyncRef);
    await kit.settle();
    expect(kit.events.filter((e) => e.type === 'stopped').map((e) => e.path)).toEqual([
      '/user/sync',
      '/user/async',
    ]);
    expect(kit.logs.map((l) => l.msg)).toEqual([
      'postStop threw; stopping anyway',
      'postStop rejected; stopping anyway',
    ]);
  });
});
