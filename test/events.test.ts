import { describe, expect, it } from 'vitest';
import { actor } from '../src/actor.js';
import { createTestKit } from '../src/testkit/kit.js';
import type { SystemEvent } from '../src/types.js';

const idle = actor<never, null>({ initial: null, receive: (s) => s });

describe('event stream', () => {
  it("stamps events with increasing seq and the scheduler's time", () => {
    const kit = createTestKit({ startTime: 100 });
    kit.system.spawn(idle, 'a');
    kit.scheduler.advanceTo(250);
    kit.system.spawn(idle, 'b');
    expect(kit.events.map((e) => [e.seq, e.at])).toEqual([
      [1, 100],
      [2, 250],
    ]);
  });

  it('isolates a listener that throws from actors and other listeners', async () => {
    const kit = createTestKit();
    const seen: string[] = [];
    kit.system.events.subscribe(() => {
      throw new Error('bad listener');
    });
    kit.system.events.subscribe((e) => seen.push(e.type));
    const probe = kit.probe<string>();
    const ref = kit.system.spawn(
      actor<string, null>({
        initial: null,
        receive: (s, msg) => {
          probe.ref.tell(msg);
          return s;
        },
      }),
    );
    ref.tell('still works');
    await kit.settle();
    expect(seen).toEqual(['spawned']);
    expect(probe.expectMessage()).toBe('still works');
    expect(kit.logs).toMatchObject([
      { level: 'error', msg: 'an event listener threw; skipped it', fields: { event: 'spawned' } },
    ]);
  });

  it('stops delivering after unsubscribe, even mid-delivery', () => {
    const kit = createTestKit();
    const first: number[] = [];
    const second: number[] = [];
    const offFirst = kit.system.events.subscribe((e: SystemEvent) => {
      first.push(e.seq);
      offFirst();
    });
    const offSecond = kit.system.events.subscribe((e) => second.push(e.seq));
    kit.system.spawn(idle);
    kit.system.spawn(idle);
    offSecond();
    offSecond(); // harmless twice
    kit.system.spawn(idle);
    expect(first).toEqual([1]);
    expect(second).toEqual([1, 2]);
  });

  it('rejects a listener that is not a function', () => {
    const kit = createTestKit();
    expect(() => kit.system.events.subscribe('nope' as never)).toThrow(TypeError);
  });
});
