import { describe, expect, it } from 'vitest';
import { actor } from '../src/actor.js';
import { AskTimeoutError, NotAChildError } from '../src/errors.js';
import { hooksOf, inspectSystem } from '../src/internal.js';
import { createActorSystem } from '../src/system.js';
import { createTestKit } from '../src/testkit/kit.js';
import type { ActorRef } from '../src/types.js';
import { idle, tree } from './helpers/actors.js';

// Milestone 4, T1: the hooks the cluster uses (decision 0025). Never exported.

type Echo = { readonly replyTo: ActorRef<string> };
const echo = actor<Echo, null>({
  initial: null,
  receive: (state, msg) => {
    msg.replyTo.tell('pong');
    return state;
  },
});
// Never answers, so an ask to it waits for its timeout.
const silent = actor<Echo, null>({ initial: null, receive: (state) => state });

describe('the system hooks', () => {
  it('are on every system the core makes, and not enumerable', () => {
    const system = createActorSystem({ name: 'hooked' });
    const hooks = hooksOf(system);
    expect(Object.getOwnPropertySymbols(system).map((s) => s.description)).toContain(
      'troupe.hooks',
    );
    expect(JSON.stringify(Object.keys(system))).not.toContain('hooks');
    expect(typeof hooks.lookup).toBe('function');
    expect(() => hooksOf({} as never)).toThrow(TypeError);
  });
});

describe('the /system guardian', () => {
  it('spawns under /system, out of the /user walk, and system.stop refuses its actors', async () => {
    const kit = createTestKit();
    const hooks = hooksOf(kit.system);
    const sharding = hooks.spawnSystem(idle, 'sharding');
    const user = kit.system.spawn(idle, 'shows');
    await kit.settle();
    expect(sharding.path).toBe('/system/sharding');
    expect(kit.events).toContainEqual(
      expect.objectContaining({ type: 'spawned', path: '/system/sharding' }),
    );
    expect(
      inspectSystem(kit.system)
        .walk()
        .map((c) => c.path),
    ).toEqual(['/user/shows']);
    expect(() => {
      kit.system.stop(sharding);
    }).toThrow(NotAChildError);
    kit.system.stop(user);
    await kit.settle();
  });

  it('checks names and options as spawn does', () => {
    const hooks = hooksOf(createTestKit().system);
    hooks.spawnSystem(idle, 'taken');
    expect(() => hooks.spawnSystem(idle, 'taken')).toThrow('already taken under /system');
    expect(() => hooks.spawnSystem(idle, 'x', { nope: 1 } as never)).toThrow(TypeError);
  });

  it('stops after everything under /user when the system terminates', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    kit.system.events.subscribe((e) => {
      if (e.type === 'stopped') log.push(e.path);
    });
    const hooks = hooksOf(kit.system);
    hooks.spawnSystem(tree({ name: 'region', children: [{ name: 'shard' }] }, []), 'region');
    kit.system.spawn(tree({ name: 'a', children: [{ name: 'a1', asyncStop: true }] }, []), 'a');
    kit.system.spawn(idle, 'b');
    await kit.settle();

    let resolved = false;
    const done = kit.system.terminate().then(() => {
      resolved = true;
    });
    await kit.settle();
    await done;
    expect(resolved).toBe(true);
    expect(log).toEqual([
      '/user/b',
      '/user/a/a1',
      '/user/a',
      '/system/region/shard',
      '/system/region',
    ]);
  });

  it('terminates at once with only /system actors, or none at all', async () => {
    const kit = createTestKit();
    hooksOf(kit.system).spawnSystem(idle, 'alone');
    await kit.settle();
    const done = kit.system.terminate();
    await kit.settle();
    await done;
    expect(kit.events.filter((e) => e.type === 'stopped')).toEqual([
      expect.objectContaining({ path: '/system/alone' }),
    ]);

    await createTestKit().system.terminate();
  });

  it('leaves /system running while /user actors stop on their own', async () => {
    const kit = createTestKit();
    const hooks = hooksOf(kit.system);
    const region = hooks.spawnSystem(idle, 'region');
    kit.system.stop(kit.system.spawn(idle, 'only'));
    await kit.settle();
    expect(hooks.lookup('/system/region')).toBe(region);
  });
});

describe('lookup by path', () => {
  it('finds live actors under /user and /system, at any depth', async () => {
    const kit = createTestKit();
    const hooks = hooksOf(kit.system);
    const parent = kit.system.spawn(tree({ name: 'a', children: [{ name: 'a1' }] }, []), 'a');
    const region = hooks.spawnSystem(idle, 'region');
    const anonymous = kit.system.spawn(idle);
    await kit.settle();
    expect(hooks.lookup('/user/a')).toBe(parent);
    expect(hooks.lookup('/user/a/a1')?.path).toBe('/user/a/a1');
    expect(hooks.lookup('/system/region')).toBe(region);
    expect(hooks.lookup(anonymous.path)).toBe(anonymous);
  });

  it('finds nothing for a stopped actor, a missing one, or a path outside the tree', async () => {
    const kit = createTestKit();
    const hooks = hooksOf(kit.system);
    const gone = kit.system.spawn(idle, 'gone');
    await kit.settle();
    kit.system.stop(gone);
    await kit.settle();
    for (const path of [
      '/user/gone',
      '/user/missing',
      '/user/a/b',
      '/user',
      '/system',
      '/',
      '',
      'user/gone',
      '/elsewhere/x',
      '/temp/$1',
    ]) {
      expect(hooks.lookup(path), path).toBeUndefined();
    }
  });

  it('finds a temporary ask ref while its ask waits, and not after a reply', async () => {
    const kit = createTestKit();
    const hooks = hooksOf(kit.system);
    const target = kit.system.spawn(echo, 'echo');
    let replyTo: ActorRef<string> | undefined;
    const answer = target.ask<string>((r) => {
      replyTo = r;
      return { replyTo: r };
    });
    expect(replyTo).toBeDefined();
    const path = replyTo?.path ?? '';
    expect(path).toMatch(/^\/temp\/\$\d+$/);
    expect(hooks.lookup(path)).toBe(replyTo);
    await kit.settle();
    await expect(answer).resolves.toBe('pong');
    expect(hooks.lookup(path)).toBeUndefined();
  });

  it('finds a temporary ref until its ask times out, and not after', async () => {
    const kit = createTestKit();
    const hooks = hooksOf(kit.system);
    const target = kit.system.spawn(silent, 'silent');
    let path = '';
    const answer = target.ask<string>(
      (r) => {
        path = r.path;
        return { replyTo: r };
      },
      { timeoutMs: 100 },
    );
    await kit.advance(99);
    expect(hooks.lookup(path)).toBeDefined();
    const failed = expect(answer).rejects.toThrow(AskTimeoutError);
    await kit.advance(1);
    await failed;
    expect(hooks.lookup(path)).toBeUndefined();
  });

  it('finds nothing for an ask whose build threw, or after terminate', async () => {
    const kit = createTestKit();
    const hooks = hooksOf(kit.system);
    const target = kit.system.spawn(silent, 'silent');
    let path = '';
    await expect(
      target.ask((r) => {
        path = r.path;
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    expect(hooks.lookup(path)).toBeUndefined();

    const waiting = target.ask<string>((r) => {
      path = r.path;
      return { replyTo: r };
    });
    const rejected = expect(waiting).rejects.toThrow('terminating');
    const done = kit.system.terminate();
    await kit.settle();
    await done;
    await rejected;
    expect(hooks.lookup(path)).toBeUndefined();
  });
});

describe('owns, makeRef and deadLetter', () => {
  it('owns the refs this system made, and no other', async () => {
    const kit = createTestKit();
    const other = createTestKit();
    const hooks = hooksOf(kit.system);
    const ref = kit.system.spawn(echo, 'echo');
    const probe = kit.probe<string>();
    let temp: unknown;
    void ref.ask((r) => {
      temp = r;
      return { replyTo: r };
    });
    const made = hooks.makeRef<string>('troupe://c@n:1#2/user/x', () => undefined);
    expect([ref, probe.ref, temp, made].map((r) => hooks.owns(r))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    const lookalike = { path: '/user/echo', tell: ref.tell, ask: ref.ask };
    for (const notOurs of [other.system.spawn(idle), lookalike, null, 'x', undefined]) {
      expect(hooks.owns(notOurs)).toBe(false);
    }
    await kit.settle();
  });

  it('makes refs that ask through this system', async () => {
    const kit = createTestKit();
    const hooks = hooksOf(kit.system);
    const target = kit.system.spawn(echo, 'echo');
    // A stand-in for a remote ref: its tell forwards, as remoting will, through a frame.
    const remote = hooks.makeRef<Echo>('troupe://c@n:1#2/user/echo', (msg) => {
      target.tell(msg);
    });
    const answer = remote.ask<string>((replyTo) => ({ replyTo }));
    await kit.settle();
    await expect(answer).resolves.toBe('pong');
  });

  it('publishes dead letters with any reason', () => {
    const kit = createTestKit();
    const hooks = hooksOf(kit.system);
    for (const reason of ['unreachable', 'unserializable', 'invalid'] as const) {
      hooks.deadLetter('/user/x', { n: 1 }, reason);
    }
    expect(kit.events.filter((e) => e.type === 'deadLetter')).toEqual([
      expect.objectContaining({ recipient: '/user/x', message: { n: 1 }, reason: 'unreachable' }),
      expect.objectContaining({ reason: 'unserializable' }),
      expect.objectContaining({ reason: 'invalid' }),
    ]);
  });
});
