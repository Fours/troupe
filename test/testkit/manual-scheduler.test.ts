import { describe, expect, it } from 'vitest';
import { ManualScheduler } from '../../src/testkit/manual-scheduler.js';

describe('ManualScheduler', () => {
  it('starts at 0, or at startTime', () => {
    expect(new ManualScheduler().now()).toBe(0);
    expect(new ManualScheduler({ startTime: 1_700_000_000_000 }).now()).toBe(1_700_000_000_000);
  });

  it('runs nothing until asked', () => {
    const s = new ManualScheduler();
    let ran = 0;
    s.runSoon(() => ran++);
    s.setTimer(() => ran++, 0);
    expect(ran).toBe(0);
    expect(s.runReady()).toBe(2);
    expect(ran).toBe(2);
  });

  it('runs queued tasks in FIFO order', () => {
    const s = new ManualScheduler();
    const order: number[] = [];
    for (let i = 0; i < 5; i++) s.runSoon(() => order.push(i));
    s.runReady();
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('fires timers in due order, and in creation order on a tie', () => {
    const s = new ManualScheduler();
    const order: string[] = [];
    s.setTimer(() => order.push('c@30'), 30);
    s.setTimer(() => order.push('a@10'), 10);
    s.setTimer(() => order.push('b1@20'), 20);
    s.setTimer(() => order.push('b2@20'), 20);
    s.setTimer(() => order.push('b3@20'), 20);
    s.setTimer(() => order.push('a2@10'), 10);
    s.advanceTo(100);
    expect(order).toEqual(['a@10', 'a2@10', 'b1@20', 'b2@20', 'b3@20', 'c@30']);
  });

  it('keeps creation order on ties across many timers', () => {
    // Enough entries to exercise the heap's sift-down on both sides.
    const s = new ManualScheduler();
    const order: number[] = [];
    const dues = Array.from({ length: 200 }, (_, i) => (i * 37) % 11);
    dues.forEach((due, i) => s.setTimer(() => order.push(i), due));
    s.advanceTo(20);
    const expected = dues
      .map((due, i) => ({ due, i }))
      .sort((a, b) => a.due - b.due || a.i - b.i)
      .map(({ i }) => i);
    expect(order).toEqual(expected);
  });

  it("reads each timer's due time from now() while it runs, and ends at the target", () => {
    const s = new ManualScheduler({ startTime: 1000 });
    const seen: number[] = [];
    s.setTimer(() => seen.push(s.now()), 5);
    s.setTimer(() => seen.push(s.now()), 50);
    s.advanceTo(2000);
    expect(seen).toEqual([1005, 1050]);
    expect(s.now()).toBe(2000);
  });

  it('runs the tasks a timer queues before the next timer', () => {
    const s = new ManualScheduler();
    const order: string[] = [];
    s.setTimer(() => {
      order.push('timer 1');
      s.runSoon(() => {
        order.push('task from 1');
        s.runSoon(() => order.push('task from task'));
      });
    }, 10);
    s.setTimer(() => order.push('timer 2'), 10);
    s.advanceTo(10);
    expect(order).toEqual(['timer 1', 'task from 1', 'task from task', 'timer 2']);
  });

  it('fires a timer set during advanceTo when it falls due within the advance', () => {
    const s = new ManualScheduler();
    const fired: number[] = [];
    s.setTimer(() => {
      fired.push(s.now());
      s.setTimer(() => fired.push(s.now()), 30); // due at 40, inside the advance
      s.setTimer(() => fired.push(s.now()), 200); // due at 210, after it
    }, 10);
    s.advanceTo(100);
    expect(fired).toEqual([10, 40]);
    expect(s.pendingTimers()).toBe(1);
    s.advanceTo(210);
    expect(fired).toEqual([10, 40, 210]);
  });

  it('reports the earliest live timer with nextTimerAt', () => {
    const s = new ManualScheduler({ startTime: 5 });
    expect(s.nextTimerAt()).toBeUndefined();
    const cancelFirst = s.setTimer(() => {}, 10);
    s.setTimer(() => {}, 20);
    expect(s.nextTimerAt()).toBe(15);
    cancelFirst();
    expect(s.nextTimerAt()).toBe(25);
    s.advanceTo(25);
    expect(s.nextTimerAt()).toBeUndefined();
  });

  it('fires a periodic chain at every interval', () => {
    const s = new ManualScheduler();
    const fired: number[] = [];
    const tick = () => {
      fired.push(s.now());
      s.setTimer(tick, 25);
    };
    s.setTimer(tick, 25);
    s.advanceTo(100);
    expect(fired).toEqual([25, 50, 75, 100]);
  });

  it('cancels a timer, and cancelling twice or after it ran is harmless', () => {
    const s = new ManualScheduler();
    let fired = 0;
    const cancel = s.setTimer(() => fired++, 10);
    expect(s.pendingTimers()).toBe(1);
    cancel();
    cancel();
    expect(s.pendingTimers()).toBe(0);
    s.advanceTo(20);
    expect(fired).toBe(0);

    const cancelLater = s.setTimer(() => fired++, 5);
    s.advanceTo(30);
    expect(fired).toBe(1);
    cancelLater();
    expect(s.pendingTimers()).toBe(0);
  });

  it('cancels a timer that is already due but has not run yet', () => {
    const s = new ManualScheduler();
    const order: string[] = [];
    let cancelSecond = () => {};
    s.setTimer(() => {
      order.push('first');
      cancelSecond();
    }, 10);
    cancelSecond = s.setTimer(() => order.push('second'), 10);
    s.advanceTo(10);
    expect(order).toEqual(['first']);
  });

  it('does not fire a timer due later than now on runReady', () => {
    const s = new ManualScheduler();
    let fired = false;
    s.setTimer(() => (fired = true), 1);
    expect(s.runReady()).toBe(0);
    expect(fired).toBe(false);
  });

  it('treats a negative or NaN delay as 0', () => {
    const s = new ManualScheduler({ startTime: 100 });
    const seen: number[] = [];
    s.setTimer(() => seen.push(s.now()), -5);
    s.setTimer(() => seen.push(s.now()), Number.NaN);
    s.runReady();
    expect(seen).toEqual([100, 100]);
  });

  it('counts pending timers', () => {
    const s = new ManualScheduler();
    s.setTimer(() => {}, 10);
    s.setTimer(() => {}, 20);
    const cancel = s.setTimer(() => {}, 30);
    expect(s.pendingTimers()).toBe(3);
    cancel();
    s.advanceTo(10);
    expect(s.pendingTimers()).toBe(1);
  });

  it('refuses to move time backwards', () => {
    const s = new ManualScheduler({ startTime: 50 });
    expect(() => {
      s.advanceTo(49);
    }).toThrow(RangeError);
    expect(() => {
      s.advanceTo(Number.NaN);
    }).toThrow(RangeError);
    s.advanceTo(50);
    expect(s.now()).toBe(50);
  });

  it('lets a throwing task out, and stays usable', () => {
    const s = new ManualScheduler();
    const order: string[] = [];
    s.runSoon(() => {
      throw new Error('boom');
    });
    s.runSoon(() => order.push('after'));
    expect(() => s.runReady()).toThrow('boom');
    expect(s.runReady()).toBe(1);
    expect(order).toEqual(['after']);
  });

  it('throws on a task that re-queues itself without end', () => {
    const s = new ManualScheduler({ maxSteps: 50 });
    const loop = () => {
      s.runSoon(loop);
    };
    s.runSoon(loop);
    expect(() => s.runReady()).toThrow(/re-queuing itself/);
  });

  it('throws on a zero-delay timer that re-arms itself without end', () => {
    const s = new ManualScheduler({ maxSteps: 50 });
    const loop = () => s.setTimer(loop, 0);
    s.setTimer(loop, 0);
    expect(() => {
      s.advanceTo(10);
    }).toThrow(/re-queuing itself/);
  });

  it('gives each runReady call its own step budget', () => {
    const s = new ManualScheduler({ maxSteps: 10 });
    for (let call = 0; call < 5; call++) {
      for (let i = 0; i < 10; i++) s.runSoon(() => {});
      expect(s.runReady()).toBe(10);
    }
  });

  it('runs a long queue without slowing down', () => {
    // Crosses the queue's compaction threshold, and checks nothing is lost or reordered.
    const s = new ManualScheduler();
    const seen: number[] = [];
    for (let i = 0; i < 5000; i++) s.runSoon(() => seen.push(i));
    expect(s.runReady()).toBe(5000);
    expect(seen).toEqual(Array.from({ length: 5000 }, (_, i) => i));
  });

  it('validates its options', () => {
    expect(() => new ManualScheduler({ startTime: Number.NaN })).toThrow(TypeError);
    expect(() => new ManualScheduler({ startTime: Infinity })).toThrow(TypeError);
    expect(() => new ManualScheduler({ maxSteps: 0 })).toThrow(TypeError);
    expect(() => new ManualScheduler({ maxSteps: 1.5 })).toThrow(TypeError);
    expect(() => new ManualScheduler({ steps: 5 } as never)).toThrow(/unknown option "steps"/);
  });
});
