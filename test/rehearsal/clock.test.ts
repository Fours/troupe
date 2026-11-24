import { describe, expect, it } from 'vitest';
import { inMemoryNetwork } from '../../src/cluster/memory.js';
import type { Connection } from '../../src/cluster/transport.js';
import { NodeClock, throughClock } from '../../src/rehearsal/clock.js';
import { ManualScheduler } from '../../src/testkit/manual-scheduler.js';
import { seededRandom } from '../../src/testkit/random.js';

// Milestone 5, T1 (decision 0033): a clock per node, on one simulation clock.

describe('a node clock', () => {
  it('fires a timer when its own clock reaches it, at its own rate', () => {
    const sim = new ManualScheduler();
    const fast = new NodeClock(sim, { driftPpm: 10_000 });
    const slow = new NodeClock(sim, { driftPpm: -10_000 });
    const fired: string[] = [];
    fast.setTimer(() => fired.push(`fast ${String(sim.now())} ${String(fast.now())}`), 1_000);
    slow.setTimer(() => fired.push(`slow ${String(sim.now())} ${String(slow.now())}`), 1_000);
    sim.advanceTo(2_000);
    // 1.01 ms a ms reaches 1,000 at 991 (990 reads 999), and 0.99 ms a ms at 1,011.
    expect(fired).toEqual(['fast 991 1000', 'slow 1011 1000']);
    expect(fast.now()).toBe(2_020);
    expect(slow.now()).toBe(1_980);
  });

  it('starts where it is told to, and reads the simulation when it is not', () => {
    const sim = new ManualScheduler({ startTime: 500 });
    expect(new NodeClock(sim).now()).toBe(500);
    const clock = new NodeClock(sim, { startAt: 0 });
    sim.advanceTo(800);
    expect(clock.now()).toBe(300);
  });

  it('reads whole milliseconds that never go back, and never fires a timer early or late: a property test', () => {
    const chance = seededRandom(33);
    const int = (from: number, to: number): number => from + Math.floor(chance() * (to - from));
    for (let round = 0; round < 200; round++) {
      const sim = new ManualScheduler({ startTime: int(0, 1_000) });
      const simStart = sim.now();
      const driftPpm = int(-20_000, 20_000);
      const startAt = int(0, 1_000_000);
      const clock = new NodeClock(sim, { driftPpm, startAt });
      // The clock's reading at simulation time `t`, worked out on its own.
      const reading = (t: number): number =>
        startAt + Math.floor((t - simStart) * (1 + driftPpm / 1_000_000));
      let last = clock.now();
      const check = (): void => {
        const now = clock.now();
        expect(Number.isInteger(now)).toBe(true);
        expect(now).toBeGreaterThanOrEqual(last);
        expect(now).toBe(reading(sim.now()));
        last = now;
      };
      const schedule = (depth: number): void => {
        const setAt = sim.now();
        const target = clock.now() + int(0, 5_000);
        clock.setTimer(() => {
          check();
          expect(clock.now()).toBeGreaterThanOrEqual(target);
          // The first whole millisecond that reaches it: a millisecond earlier, it read less.
          if (sim.now() > setAt) expect(reading(sim.now() - 1)).toBeLessThan(target);
          if (depth < 5) schedule(depth + 1);
        }, target - clock.now());
      };
      for (let i = 0; i < 5; i++) schedule(0);
      for (let t = sim.now(); sim.nextTimerAt() !== undefined; t += int(1, 400)) {
        sim.advanceTo(t);
        check();
      }
    }
  });

  it('fires timers due at the same time in the order they were set, across clocks', () => {
    const sim = new ManualScheduler();
    const a = new NodeClock(sim);
    const b = new NodeClock(sim);
    const fired: string[] = [];
    a.setTimer(() => fired.push('a1'), 10);
    b.setTimer(() => fired.push('b1'), 10);
    a.setTimer(() => fired.push('a2'), 10);
    b.runSoon(() => fired.push('b task'));
    sim.advanceTo(10);
    expect(fired).toEqual(['b task', 'a1', 'b1', 'a2']);
  });

  it('cancels a timer, and its timer on the simulation', () => {
    const sim = new ManualScheduler();
    const clock = new NodeClock(sim, { driftPpm: 200 });
    const fired: number[] = [];
    const cancel = clock.setTimer(() => fired.push(1), 100);
    expect(sim.pendingTimers()).toBe(1);
    cancel();
    cancel();
    expect(sim.pendingTimers()).toBe(0);
    sim.advanceTo(200);
    expect(fired).toEqual([]);
  });

  it('treats a negative or NaN delay as 0', () => {
    const sim = new ManualScheduler();
    const clock = new NodeClock(sim, { driftPpm: -500 });
    const fired: string[] = [];
    clock.setTimer(() => fired.push('negative'), -5);
    clock.setTimer(() => fired.push('nan'), NaN);
    sim.runReady();
    expect(fired).toEqual(['negative', 'nan']);
  });

  it('throws for options that cannot be used, when it is made', () => {
    const sim = new ManualScheduler();
    expect(() => new NodeClock(sim, { driftPpm: 1.5 })).toThrow(TypeError);
    expect(() => new NodeClock(sim, { driftPpm: 100_001 })).toThrow(/at most 100000/);
    expect(() => new NodeClock(sim, { driftPpm: -100_001 })).toThrow(TypeError);
    expect(() => new NodeClock(sim, { startAt: -1 })).toThrow(TypeError);
    expect(() => new NodeClock(sim, { rate: 2 } as never)).toThrow(/unknown option "rate"/);
    expect(new NodeClock(sim, { driftPpm: -100_000 }).now()).toBe(0);
  });
});

describe('a paused node', () => {
  it('runs nothing until it resumes, then everything that fell due, in order, while the other nodes carry on', () => {
    const sim = new ManualScheduler();
    const a = new NodeClock(sim);
    const b = new NodeClock(sim);
    const log: string[] = [];
    const note = (what: string) => () => log.push(`${String(sim.now())} ${what}`);
    a.setTimer(note('a timer 100'), 100);
    a.setTimer(() => {
      note('a timer 200')();
      // Queued by the backlog: it runs after the backlog, not inside it.
      a.runSoon(note('a task from 200'));
    }, 200);
    const cancelled = a.setTimer(note('a timer 250, cancelled'), 250);
    b.setTimer(note('b timer 150'), 150);
    sim.setTimer(() => {
      a.pause();
      a.pause();
      expect(a.paused).toBe(true);
      a.runSoon(note('a task queued while paused'));
      a.setTimer(note('a timer set while paused, due 260'), 210);
    }, 50);
    sim.setTimer(cancelled, 120);
    sim.setTimer(() => {
      // Its clock kept going.
      expect(a.now()).toBe(300);
      a.resume();
      a.resume();
      expect(a.paused).toBe(false);
      a.setTimer(note('a timer set on resuming'), 0);
    }, 300);
    sim.advanceTo(1_000);
    expect(log).toEqual([
      '150 b timer 150',
      '300 a task queued while paused',
      '300 a timer 100',
      '300 a timer 200',
      '300 a timer set while paused, due 260',
      '300 a task from 200',
      '300 a timer set on resuming',
    ]);
  });

  it('keeps the rest of its backlog when a task in it throws', () => {
    const sim = new ManualScheduler();
    const clock = new NodeClock(sim);
    const ran: string[] = [];
    clock.pause();
    clock.runSoon(() => {
      throw new Error('boom');
    });
    clock.runSoon(() => ran.push('after'));
    sim.runReady();
    clock.resume();
    expect(() => sim.runReady()).toThrow('boom');
    sim.runReady();
    expect(ran).toEqual(['after']);
  });

  it('stops again if it is paused before its backlog runs', () => {
    const sim = new ManualScheduler();
    const clock = new NodeClock(sim);
    const ran: string[] = [];
    clock.pause();
    clock.runSoon(() => ran.push('one'));
    sim.runReady();
    clock.resume();
    clock.pause();
    sim.runReady();
    expect(ran).toEqual([]);
    clock.resume();
    sim.runReady();
    expect(ran).toEqual(['one']);
  });

  it('gets its frames, connections and closes only when it wakes, in order, and loses none', () => {
    const sim = new ManualScheduler();
    const network = inMemoryNetwork({ scheduler: sim, latencyMs: 5 });
    const clock = new NodeClock(sim);
    const a = throughClock(network.transport('a'), clock);
    const b = network.transport('b');
    const heard: string[] = [];
    let accepted: Connection | undefined;
    void a.listen((connection) => {
      accepted = connection;
      heard.push(`${String(sim.now())} connection`);
      connection.onFrame((frame) => heard.push(`${String(sim.now())} ${frame}`));
      connection.onClose(() => heard.push(`${String(sim.now())} closed`));
    });
    sim.runReady();
    clock.pause();
    const out = b.connect('a');
    out.send('one');
    out.send('two');
    sim.advanceTo(20);
    out.close();
    sim.advanceTo(100);
    expect(heard).toEqual([]);
    clock.resume();
    sim.runReady();
    expect(heard).toEqual(['100 connection', '100 one', '100 two', '100 closed']);
    // A listener added after the close still hears of it, on the node's clock.
    accepted?.onClose(() => heard.push('late listener'));
    sim.runReady();
    expect(heard.at(-1)).toBe('late listener');
  });

  it('sends while it runs, and its outgoing connections come through its clock too', async () => {
    const sim = new ManualScheduler();
    const network = inMemoryNetwork({ scheduler: sim, latencyMs: 1 });
    const clock = new NodeClock(sim);
    const refused: string[] = [];
    const a = throughClock(network.transport('a'), clock);
    const b = network.transport('b');
    const heard: string[] = [];
    void b.listen((connection) => {
      connection.onFrame((frame) => {
        heard.push(`b ${frame}`);
        connection.send(`re ${frame}`);
      });
    });
    await a.listen(
      () => {},
      (reason) => refused.push(reason),
    );
    const out = a.connect('b');
    out.onFrame((frame) => heard.push(`a ${frame}`));
    out.onClose(() => heard.push('a closed'));
    out.send('hi');
    sim.advanceTo(10);
    clock.pause();
    out.send('again');
    sim.advanceTo(20);
    expect(heard).toEqual(['b hi', 'a re hi', 'b again']);
    clock.resume();
    sim.runReady();
    expect(heard.at(-1)).toBe('a re again');
    out.close();
    sim.advanceTo(30);
    expect(heard.at(-1)).toBe('a closed');
    expect(a.address).toBe('a');
    await a.close();
    expect(refused).toEqual([]);
  });
});
