import { describe, expect, it } from 'vitest';
import { actor } from '../src/actor.js';
import { ActorNameError, ActorStoppedError } from '../src/errors.js';
import { createTestKit } from '../src/testkit/kit.js';
import type { ActorContext, AnyRef } from '../src/types.js';
import { idle } from './helpers/actors.js';

describe('children', () => {
  it("spawns children under the parent's path, with their own name space", async () => {
    const kit = createTestKit();
    const seen: string[] = [];
    const parent = actor<'go', null>({
      initial: (ctx) => {
        seen.push(ctx.spawn(idle, 'kid').path);
        seen.push(ctx.spawn(idle).path);
        const nested = ctx.spawn(
          actor<never, null>({
            initial: (inner) => {
              seen.push(inner.spawn(idle, 'grandkid').path);
              seen.push(inner.spawn(idle).path);
              return null;
            },
            receive: (s) => s,
          }),
          'nested',
        );
        seen.push(nested.path);
        return null;
      },
      receive: (s) => s,
    });
    kit.system.spawn(parent, 'parent');
    // A top-level actor may share a child's name: names are per parent.
    kit.system.spawn(idle, 'kid');
    await kit.settle();
    expect(seen).toEqual([
      '/user/parent/kid',
      '/user/parent/$1',
      '/user/parent/nested',
      '/user/parent/nested/grandkid',
      '/user/parent/nested/$1',
    ]);
    expect(kit.events.filter((e) => e.type === 'spawned').map((e) => e.path)).toContain(
      '/user/kid',
    );
  });

  it('finds children by name and lists them in spawn order', async () => {
    const kit = createTestKit();
    let ctx: ActorContext<'go'> | undefined;
    const refs: AnyRef[] = [];
    kit.system.spawn(
      actor<'go', null>({
        initial: (c) => {
          ctx = c;
          refs.push(c.spawn(idle, 'b'), c.spawn(idle, 'a'), c.spawn(idle, 'c'));
          return null;
        },
        receive: (s) => s,
      }),
    );
    await kit.settle();
    expect(ctx?.children()).toEqual(refs);
    expect(ctx?.child('a')).toBe(refs[1]);
    expect(ctx?.child('missing')).toBeUndefined();
  });

  it('rejects a duplicate child name', async () => {
    const kit = createTestKit();
    let error: unknown;
    kit.system.spawn(
      actor<never, null>({
        initial: (ctx) => {
          ctx.spawn(idle, 'twin');
          try {
            ctx.spawn(idle, 'twin');
          } catch (e) {
            error = e;
          }
          return null;
        },
        receive: (s) => s,
      }),
      'parent',
    );
    await kit.settle();
    expect(error).toBeInstanceOf(ActorNameError);
    expect(String(error)).toMatch(/already taken under \/user\/parent/);
  });

  it('refuses to spawn from a context whose actor has stopped', async () => {
    const kit = createTestKit();
    let ctx: ActorContext<never> | undefined;
    const ref = kit.system.spawn(
      actor<never, null>({
        initial: (c) => {
          ctx = c;
          return null;
        },
        receive: (s) => s,
      }),
    );
    await kit.settle();
    kit.system.stop(ref);
    await kit.settle();
    expect(() => ctx?.spawn(idle)).toThrow(ActorStoppedError);
  });
});
