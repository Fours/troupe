import { actor, createActorSystem, type ActorRef } from '@kylewillett/troupe';
import { inMemoryPersistence, persistentActor } from '@kylewillett/troupe/persistence';
import { ManualScheduler, seededRandom } from '@kylewillett/troupe/testkit';
import { describe, expect, it } from 'vitest';
import { DrivenClock, MAX_TICK_MS, SettleError, type Speed } from '../../demo/src/domain/clock.ts';
import { nextTurn } from './helpers.ts';

const clockAt = (speed: Speed = 1) => {
  const scheduler = new ManualScheduler();
  return { scheduler, clock: new DrivenClock({ scheduler, yieldToEventLoop: nextTurn, speed }) };
};

describe('the driven clock', () => {
  it('moves virtual time by real time at speed 1', async () => {
    const { clock } = clockAt();
    await clock.tick(16);
    await clock.tick(17);
    expect(clock.now()).toBe(33);
  });

  it('stops time while paused, and starts it again', async () => {
    const { scheduler, clock } = clockAt();
    let fired = 0;
    scheduler.setTimer(() => fired++, 50);
    await clock.tick(40);
    clock.speed = 0;
    for (let i = 0; i < 100; i++) await clock.tick(16);
    expect(clock.now()).toBe(40);
    expect(fired).toBe(0);
    clock.speed = 1;
    await clock.tick(10);
    expect(fired).toBe(1);
  });

  it('runs a quarter as fast at ¼×, carrying the fractions', async () => {
    const { clock } = clockAt(0.25);
    // 7 ms a frame is 1.75 ms of virtual time: whole milliseconds only, the rest carried.
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      await clock.tick(7);
      seen.push(clock.now());
    }
    expect(seen).toEqual([1, 3, 5, 7]);
    for (let i = 0; i < 96; i++) await clock.tick(10);
    expect(clock.now()).toBe(247);
  });

  it('runs four times as fast at 4×', async () => {
    const { clock } = clockAt(4);
    for (let i = 0; i < 10; i++) await clock.tick(16);
    expect(clock.now()).toBe(640);
  });

  it(`counts at most ${String(MAX_TICK_MS)} ms of a long frame, and nothing for a negative one`, async () => {
    const { clock } = clockAt(4);
    await clock.tick(60_000);
    expect(clock.now()).toBe(MAX_TICK_MS * 4);
    await clock.tick(-5);
    expect(clock.now()).toBe(MAX_TICK_MS * 4);
  });

  it('refuses a speed it does not offer, and a bad advance', () => {
    const { clock } = clockAt();
    expect(() => {
      clock.speed = 2 as Speed;
    }).toThrow(RangeError);
    expect(() => clock.advance(1.5)).toThrow(RangeError);
    expect(() => clock.advance(-1)).toThrow(RangeError);
  });

  it('runs calls one at a time, in order, even when one fails', async () => {
    const { clock } = clockAt();
    const order: string[] = [];
    const first = clock.run(async () => {
      await nextTurn();
      order.push('first');
      throw new Error('boom');
    });
    const second = clock.tick(10).then(() => order.push(`tick at ${String(clock.now())}`));
    await expect(first).rejects.toThrow('boom');
    await second;
    expect(order).toEqual(['first', 'tick at 10']);
  });

  it('gives up on a system that never settles', async () => {
    const { scheduler, clock } = clockAt();
    // Work that queues more work after every turn of the event loop, forever.
    const forever = (): void => {
      void nextTurn().then(() => {
        scheduler.runSoon(forever);
      });
    };
    scheduler.runSoon(forever);
    await expect(clock.settle()).rejects.toThrow(SettleError);
  });

  // The probe behind decision 0022: a journal that resolves on microtasks, and an ask with a
  // timeout shorter than any gap between frames.
  describe('settling at every due time', () => {
    function world() {
      const scheduler = new ManualScheduler();
      const system = createActorSystem({ scheduler, random: seededRandom(1) });
      const counter = system.spawn(
        persistentActor<{ replyTo: ActorRef<number> }, number, number>({
          id: 'counter',
          persistence: inMemoryPersistence({ clock: () => scheduler.now() }),
          initial: 0,
          onCommand: (_s, msg, ctx) => ctx.persist(1).thenReply(msg.replyTo, (n) => n),
          onEvent: (s, e) => s + e,
        }),
        'counter',
      );
      const replies: string[] = [];
      const pick = seededRandom(2);
      system.spawn(
        actor<string, null>({
          initial: (ctx) => {
            ctx.timers.startSingle('go', 'go', 1 + Math.floor(pick() * 9));
            return null;
          },
          receive: (state, msg, ctx) => {
            if (msg !== 'go') {
              replies.push(`${String(ctx.now())} ${msg}`);
              return state;
            }
            ctx.pipeToSelf(
              counter.ask<number>((replyTo) => ({ replyTo }), { timeoutMs: 1 }),
              (r) => (r.ok ? `ok ${String(r.value)}` : 'timeout'),
            );
            ctx.timers.startSingle('go', 'go', 1 + Math.floor(pick() * 9));
            return state;
          },
        }),
        'driver',
      );
      const clock = new DrivenClock({ scheduler, yieldToEventLoop: nextTurn });
      return { scheduler, clock, replies };
    }

    it('lets a write finish before a later timer fires', async () => {
      const { clock, replies } = world();
      for (let i = 0; i < 60; i++) await clock.tick(16);
      expect(replies.length).toBeGreaterThan(100);
      expect(replies.filter((r) => r.endsWith('timeout'))).toEqual([]);
    });

    it('tells the same story however real time is cut into frames', async () => {
      const runs: string[][] = [];
      for (const frame of [[16], [33], [7, 25, 13, 19], [250]]) {
        const { clock, replies } = world();
        let total = 0;
        for (let i = 0; total < 1_000; i++) {
          const ms = Math.min(frame[i % frame.length] ?? 16, 1_000 - total);
          await clock.tick(ms);
          total += ms;
        }
        runs.push(replies);
      }
      for (const run of runs) expect(run).toEqual(runs[0]);
    });

    it('which one jump per frame would not', async () => {
      // The counter-example: advanceTo straight to the frame's end fires the 1 ms timeouts
      // before the writes resolve.
      const { scheduler, clock, replies } = world();
      for (let i = 0; i < 60; i++) {
        scheduler.advanceTo(scheduler.now() + 16);
        await clock.settle();
      }
      expect(replies.filter((r) => r.endsWith('timeout')).length).toBeGreaterThan(0);
    });
  });
});
