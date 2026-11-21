import { describe, expect, it } from 'vitest';
import { actor } from '../src/actor.js';
import { ActorStoppedError, ActorSystemTerminatedError } from '../src/errors.js';
import { createTestKit } from '../src/testkit/kit.js';
import type { ActorContext } from '../src/types.js';
import { idle, tree } from './helpers/actors.js';

describe('system.terminate', () => {
  it('stops everything, children first, and resolves after the last stopped event', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    kit.system.events.subscribe((e) => {
      if (e.type === 'stopped') log.push(`stopped ${e.path}`);
    });
    kit.system.spawn(tree({ name: 'a', children: [{ name: 'a1', asyncStop: true }] }, log), 'a');
    kit.system.spawn(tree({ name: 'b' }, log), 'b');
    await kit.settle();

    let resolved = false;
    const done = kit.system.terminate().then(() => {
      resolved = true;
      log.push('resolved');
    });
    expect(resolved).toBe(false);
    await kit.settle();
    await done;
    expect(log.slice(-1)).toEqual(['resolved']);
    expect(log.filter((l) => l.startsWith('stopped'))).toEqual([
      'stopped /user/b',
      'stopped /user/a/a1',
      'stopped /user/a',
    ]);
  });

  it('returns the same promise each time, and whenTerminated is it', async () => {
    const kit = createTestKit();
    kit.system.spawn(idle);
    const first = kit.system.terminate();
    expect(kit.system.terminate()).toBe(first);
    expect(kit.system.whenTerminated).toBe(first);
    await kit.settle();
    await expect(first).resolves.toBeUndefined();
  });

  it('resolves at once when there are no actors', async () => {
    const kit = createTestKit();
    await kit.system.terminate();
  });

  it('refuses spawns afterwards, and dead-letters every tell as terminated', async () => {
    const kit = createTestKit();
    let ctx: ActorContext<never> | undefined;
    const running = kit.system.spawn(
      actor<string, null>({
        initial: (c) => {
          ctx = c;
          return null;
        },
        receive: (s) => s,
      }),
      'running',
    );
    await kit.settle();
    void kit.system.terminate();
    expect(() => kit.system.spawn(idle)).toThrow(ActorSystemTerminatedError);
    // The actor hasn't had its turn to stop yet, but the system is terminating.
    expect(() => ctx?.spawn(idle)).toThrow(ActorSystemTerminatedError);
    running.tell('too late');
    await kit.settle();
    running.tell('much too late');
    // Once it has stopped, its own context refuses too.
    expect(() => ctx?.spawn(idle)).toThrow(ActorStoppedError);
    expect(
      kit.events.filter((e) => e.type === 'deadLetter').map((e) => [e.message, e.reason]),
    ).toEqual([
      ['too late', 'terminated'],
      ['much too late', 'terminated'],
    ]);
  });
});
