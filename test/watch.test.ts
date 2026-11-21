import { describe, expect, it } from 'vitest';
import { actor } from '../src/actor.js';
import { createTestKit } from '../src/testkit/kit.js';
import type { AnyRef } from '../src/types.js';
import { idle, watcher } from './helpers/actors.js';
import { deferred } from './helpers/deferred.js';

describe('death watch', () => {
  it('delivers terminated once, however many times you watch', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    const target = kit.system.spawn(idle, 'target');
    const w = kit.system.spawn(watcher(log));
    w.tell({ watch: target });
    w.tell({ watch: target });
    await kit.settle();
    kit.system.stop(target);
    await kit.settle();
    expect(log).toEqual(['watcher saw /user/target']);
  });

  it('works for any actor, not only children', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    let cousin: AnyRef | undefined;
    const uncle = kit.system.spawn(
      actor<never, null>({
        initial: (ctx) => {
          cousin = ctx.spawn(idle, 'cousin');
          return null;
        },
        receive: (s) => s,
      }),
      'uncle',
    );
    const w = kit.system.spawn(watcher(log));
    await kit.settle();
    if (cousin) w.tell({ watch: cousin });
    await kit.settle();
    kit.system.stop(uncle);
    await kit.settle();
    expect(log).toEqual(['watcher saw /user/uncle/cousin']);
  });

  it('signals at once when the target has already terminated', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    const target = kit.system.spawn(idle, 'gone');
    await kit.settle();
    kit.system.stop(target);
    await kit.settle();
    kit.system.spawn(watcher(log)).tell({ watch: target });
    await kit.settle();
    expect(log).toEqual(['watcher saw /user/gone']);
  });

  it('carries the failure of a target that stopped because it failed', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    const target = kit.system.spawn(
      actor<'fail', null>({
        initial: null,
        receive: () => {
          throw new Error('kaput');
        },
      }),
      'fails',
    );
    await kit.settle();
    target.tell('fail');
    await kit.settle();
    // Watching after the fact still gets the failure.
    kit.system.spawn(watcher(log)).tell({ watch: target });
    await kit.settle();
    expect(log).toEqual(['watcher saw /user/fails fail: Error: kaput']);
  });

  it('sends nothing after unwatch', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    const target = kit.system.spawn(idle, 'target');
    const w = kit.system.spawn(watcher(log));
    w.tell({ watch: target });
    await kit.settle();
    // The watcher is ready before the target, so it unwatches before the target stops.
    w.tell({ unwatch: target });
    kit.system.stop(target);
    await kit.settle();
    expect(log).toEqual([]);
  });

  it('drops a queued terminated when unwatch runs from inside the watcher first', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    const target = kit.system.spawn(idle, 'target');
    const gate = deferred();
    let unwatchNow = () => {};
    const w = kit.system.spawn(
      actor<'watch' | 'wait', null>({
        initial: (ctx) => {
          unwatchNow = () => {
            ctx.unwatch(target);
          };
          return null;
        },
        receive: async (s, msg, ctx) => {
          if (msg === 'watch') ctx.watch(target);
          else await gate.promise;
          return s;
        },
        onSignal: (s, signal) => {
          if (signal.type === 'terminated') log.push(`saw ${signal.ref.path}`);
          return s;
        },
      }),
    );
    w.tell('watch');
    await kit.settle();
    // Hold the watcher busy, then let the target stop: terminated queues behind the busy turn.
    w.tell('wait');
    kit.scheduler.runReady();
    kit.system.stop(target);
    kit.scheduler.runReady();
    expect(kit.events.some((e) => e.type === 'stopped' && e.path === '/user/target')).toBe(true);
    // Now unwatch, with terminated already in the watcher's system queue.
    unwatchNow();
    gate.resolve();
    await kit.settle();
    expect(log).toEqual([]);
  });

  it('treats watching yourself as a no-op', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    const self = kit.system.spawn(
      actor<'go', null>({
        initial: null,
        receive: (s, _msg, ctx) => {
          ctx.watch(ctx.self);
          ctx.stop();
          return s;
        },
        onSignal: (s, signal) => {
          log.push(signal.type);
          return s;
        },
      }),
    );
    self.tell('go');
    await kit.settle();
    expect(log).toEqual(['postStop']);
  });

  it('throws TypeError for a ref from outside this system', async () => {
    const kit = createTestKit();
    const other = createTestKit();
    const foreign = other.system.spawn(idle);
    const probe = kit.probe<never>();
    const errors: unknown[] = [];
    kit.system
      .spawn(
        actor<'go', null>({
          initial: null,
          receive: (s, _msg, ctx) => {
            for (const ref of [foreign, probe.ref]) {
              try {
                ctx.watch(ref);
              } catch (e) {
                errors.push(e);
              }
              try {
                ctx.unwatch(ref);
              } catch (e) {
                errors.push(e);
              }
            }
            return s;
          },
        }),
      )
      .tell('go');
    await kit.settle();
    expect(errors).toHaveLength(4);
    for (const e of errors) expect(e).toBeInstanceOf(TypeError);
  });

  it("stops watching once the watcher itself stops, so the target's stop sends nothing", async () => {
    const kit = createTestKit();
    const log: string[] = [];
    const target = kit.system.spawn(idle, 'target');
    const w = kit.system.spawn(watcher(log), 'w');
    w.tell({ watch: target });
    await kit.settle();
    kit.system.stop(w);
    await kit.settle();
    kit.system.stop(target);
    await kit.settle();
    expect(log).toEqual([]);
  });

  it('lets the terminated handler update state, and a throw there stops the watcher', async () => {
    const kit = createTestKit();
    const probe = kit.probe<number>();
    const a = kit.system.spawn(idle, 'a');
    const b = kit.system.spawn(idle, 'b');
    const counter = kit.system.spawn(
      actor<'report', number>({
        initial: (ctx) => {
          ctx.watch(a);
          ctx.watch(b);
          return 0;
        },
        receive: (n) => {
          probe.ref.tell(n);
          return n;
        },
        onSignal: (n, signal) => {
          if (signal.type !== 'terminated') return n;
          if (signal.ref === b) throw new Error('b went');
          return n + 1;
        },
      }),
      'counter',
    );
    await kit.settle();
    kit.system.stop(a);
    await kit.settle();
    counter.tell('report');
    await kit.settle();
    expect(probe.expectMessage()).toBe(1);
    kit.system.stop(b);
    await kit.settle();
    expect(
      kit.events.find((e) => e.type === 'stopped' && e.path === '/user/counter'),
    ).toMatchObject({ failure: new Error('b went') });
  });
});
