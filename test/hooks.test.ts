import { describe, expect, it } from 'vitest';
import { actor } from '../src/actor.js';
import { AskTimeoutError, NotAChildError } from '../src/errors.js';
import { hooksOf, inspectSystem } from '../src/internal.js';
import { supervise } from '../src/supervision.js';
import { createActorSystem } from '../src/system.js';
import { createTestKit } from '../src/testkit/kit.js';
import type { ActorRef } from '../src/types.js';
import { deferred } from './helpers/deferred.js';
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

  it('spawns a child of a live /system actor, and only of one (T6)', async () => {
    const kit = createTestKit();
    const hooks = hooksOf(kit.system);
    const sharding = hooks.spawnSystem(idle, 'sharding');
    const region = hooks.spawnSystem(idle, 'show', undefined, sharding);
    expect(region.path).toBe('/system/sharding/show');
    expect(hooks.lookup('/system/sharding/show')).toBe(region);
    expect(() => hooks.spawnSystem(idle, 'show', undefined, sharding)).toThrow(
      'already taken under /system/sharding',
    );
    const user = kit.system.spawn(idle, 'user');
    expect(() => hooks.spawnSystem(idle, 'x', undefined, user)).toThrow(
      'spawnSystem: parent must be a live actor under /system',
    );
    expect(() => hooks.spawnSystem(idle, 'x', undefined, {} as never)).toThrow(TypeError);
    const done = kit.system.terminate();
    await kit.settle();
    await done;
    expect(() => hooks.spawnSystem(idle, 'x', undefined, region)).toThrow(TypeError);
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

/** Runs what's ready without waiting for held promises, as `settle` would refuse to. */
async function turn(kit: ReturnType<typeof createTestKit>): Promise<void> {
  for (let i = 0; i < 10; i++) {
    kit.scheduler.runReady();
    await Promise.resolve();
  }
}

describe('stopWhenIdle (T7)', () => {
  /** An actor that records what it handles, and waits on `hold` for a message `slow`. */
  function recorder(got: string[], hold: Promise<void>) {
    return actor<string, null>({
      initial: null,
      receive: async (state, msg) => {
        if (msg === 'slow') await hold;
        got.push(msg);
        return state;
      },
    });
  }

  it('stops an actor after the messages already in its mailbox, an async one included', async () => {
    const kit = createTestKit();
    const hooks = hooksOf(kit.system);
    const got: string[] = [];
    const hold = deferred();
    const ref = kit.system.spawn(recorder(got, hold.promise), 'r');
    await kit.settle();
    ref.tell('slow');
    ref.tell('a');
    ref.tell('b');
    await turn(kit);
    hooks.stopWhenIdle(ref);
    ref.tell('late');
    await turn(kit);
    expect(got).toEqual([]);
    expect(kit.events.some((e) => e.type === 'stopped')).toBe(false);
    hold.resolve();
    await kit.settle();
    expect(got).toEqual(['slow', 'a', 'b']);
    const tail = kit.events.filter((e) => e.type === 'deadLetter' || e.type === 'stopped');
    expect(tail).toEqual([
      expect.objectContaining({ type: 'deadLetter', recipient: '/user/r', message: 'late' }),
      expect.objectContaining({ type: 'stopped', path: '/user/r' }),
    ]);
  });

  it('stops an idle actor at once, ignores a full mailbox, and does nothing once it’s stopping', async () => {
    const kit = createTestKit();
    const hooks = hooksOf(kit.system);
    const got: string[] = [];
    const ref = kit.system.spawn(recorder(got, Promise.resolve()), 'r', {
      mailbox: { capacity: 1 },
    });
    await kit.settle();
    ref.tell('a');
    hooks.stopWhenIdle(ref);
    hooks.stopWhenIdle(ref);
    await kit.settle();
    expect(got).toEqual(['a']);
    expect(kit.events.filter((e) => e.type === 'stopped')).toHaveLength(1);
    hooks.stopWhenIdle(ref);
    expect(() => {
      hooks.stopWhenIdle({} as never);
    }).toThrow(TypeError);
  });

  it('survives a restart in between, and stops the next incarnation once it’s idle', async () => {
    const kit = createTestKit();
    const hooks = hooksOf(kit.system);
    const got: string[] = [];
    const ref = kit.system.spawn(
      actor<string, null>({
        initial: null,
        receive: (state, msg) => {
          if (msg === 'crash') throw new Error('boom');
          got.push(msg);
          return state;
        },
      }),
      'r',
      { supervision: supervise.restart() },
    );
    await kit.settle();
    ref.tell('crash');
    ref.tell('a');
    hooks.stopWhenIdle(ref);
    await kit.settle();
    expect(got).toEqual(['a']);
    expect(kit.events.map((e) => e.type)).toEqual(expect.arrayContaining(['restarted', 'stopped']));
  });
});

describe('onTerminate (T7)', () => {
  it('runs after /user has stopped, while /system still takes messages and spawns', async () => {
    const kit = createTestKit();
    const hooks = hooksOf(kit.system);
    const log: string[] = [];
    kit.system.events.subscribe((e) => {
      if (e.type === 'stopped') log.push(`stopped ${e.path}`);
    });
    const region = hooks.spawnSystem(
      actor<string, null>({
        initial: null,
        receive: (state, msg, ctx) => {
          log.push(`got ${msg}`);
          ctx.spawn(idle, msg);
          return state;
        },
      }),
      'region',
    );
    kit.system.spawn(idle, 'user');
    const task = deferred();
    hooks.onTerminate(() => {
      log.push('task');
      region.tell('handoff');
      return task.promise;
    });
    await kit.settle();
    let done = false;
    void kit.system.terminate().then(() => {
      done = true;
    });
    await kit.settle();
    expect(log).toEqual(['task', 'stopped /user/user', 'got handoff']);
    expect(done).toBe(false);
    task.resolve();
    // The tasks aren't busy work for settle, since a cluster's need virtual time to pass.
    await turn(kit);
    await kit.settle();
    expect(done).toBe(true);
    expect(log.slice(3)).toEqual(['stopped /system/region/handoff', 'stopped /system/region']);
    // Once /system stops, it takes no more.
    region.tell('late');
    await kit.settle();
    expect(log).not.toContain('got late');
  });

  it('logs a task that fails, and terminates anyway', async () => {
    const kit = createTestKit();
    const hooks = hooksOf(kit.system);
    hooks.onTerminate(() => Promise.reject(new Error('no goodbye')));
    hooks.onTerminate(async () => {});
    const done = kit.system.terminate();
    await kit.settle();
    await done;
    expect(kit.logs).toContainEqual(
      expect.objectContaining({ level: 'error', msg: 'terminate: a termination task failed' }),
    );
    expect(() => {
      hooks.onTerminate(async () => {});
    }).toThrow(Error);
  });

  it('keeps user spawns and messages refused while the tasks run', async () => {
    const kit = createTestKit();
    const hooks = hooksOf(kit.system);
    const task = deferred();
    hooks.onTerminate(() => task.promise);
    const user = kit.system.spawn(idle, 'user');
    void kit.system.terminate();
    await kit.settle();
    expect(() => kit.system.spawn(idle, 'late')).toThrow('terminating');
    user.tell('hello' as never);
    await kit.settle();
    expect(kit.events).toContainEqual(
      expect.objectContaining({ type: 'deadLetter', recipient: '/user/user' }),
    );
    task.resolve();
    await kit.settle();
  });
});
