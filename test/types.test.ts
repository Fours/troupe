// Type tests: `npm run typecheck` checks these, since it type-checks test/. At runtime the
// assertions do nothing, and @ts-expect-error lines fail the typecheck if they stop being errors.
import { describe, expectTypeOf, it } from 'vitest';
import { actor } from '../src/actor.js';
import { supervise, type SupervisorStrategy } from '../src/supervision.js';
import type {
  ActorDef,
  ActorRef,
  AnyRef,
  Signal,
  SpawnOptions,
  SystemEvent,
} from '../src/types.js';

type A = { type: 'a' };
type B = { type: 'b' };

describe('ActorRef', () => {
  it('is contravariant in its message type', () => {
    const wide = {} as ActorRef<A | B>;
    const narrow = {} as ActorRef<A>;

    // A ref that accepts A or B can stand in for one that accepts only A...
    const ok: ActorRef<A> = wide;
    expectTypeOf(ok).toEqualTypeOf<ActorRef<A>>();
    expectTypeOf<ActorRef<A | B>>().toExtend<ActorRef<A>>();

    // ...but not the other way round: that would let B reach an actor that only handles A.
    // @ts-expect-error ActorRef<A> isn't an ActorRef<A | B>
    const bad: ActorRef<A | B> = narrow;
    expectTypeOf(bad).toEqualTypeOf<ActorRef<A | B>>();
    expectTypeOf<ActorRef<A>>().not.toExtend<ActorRef<A | B>>();
  });

  it('is assignable to AnyRef, whatever its protocol', () => {
    expectTypeOf<ActorRef<A>>().toExtend<AnyRef>();
    expectTypeOf<ActorRef<number>>().toExtend<AnyRef>();
    expectTypeOf<ActorRef<A | B | string>>().toExtend<AnyRef>();
  });

  it('only accepts its own messages', () => {
    const ref: ActorRef<A> = { path: '/user/a', tell: () => {} };
    // @ts-expect-error B isn't in the protocol
    ref.tell({ type: 'b' });
    expectTypeOf(ref.tell).parameter(0).toEqualTypeOf<A>();
  });
});

describe('actor()', () => {
  it('infers the message and state types from the definition', () => {
    const def = actor({
      initial: 0,
      receive: (count: number, msg: 'inc' | 'dec') => (msg === 'inc' ? count + 1 : count - 1),
    });
    expectTypeOf(def).toEqualTypeOf<ActorDef<'inc' | 'dec', number>>();
  });

  it('infers from an initial factory and an async receive', () => {
    const def = actor({
      initial: () => ({ items: [] as string[] }),
      receive: async (state: { items: string[] }, msg: string) => {
        await Promise.resolve();
        return { items: [...state.items, msg] };
      },
    });
    expectTypeOf(def).toEqualTypeOf<ActorDef<string, { items: string[] }>>();
  });

  it('checks receive against explicit type arguments', () => {
    actor<'inc', number>({
      initial: 0,
      // @ts-expect-error receive must return the state type
      receive: () => 'not a number',
    });
    actor<'inc', number>({
      // @ts-expect-error initial must be the state type
      initial: 'zero',
      receive: (n) => n,
    });
  });
});

describe('supervision types', () => {
  it('builds strategies that spawn accepts', () => {
    expectTypeOf(
      supervise.restartWithBackoff({ minMs: 1, maxMs: 2 }),
    ).toEqualTypeOf<SupervisorStrategy>();
    expectTypeOf<{ supervision: SupervisorStrategy }>().toExtend<SpawnOptions>();
    // Never called: it would throw. The type error is the point.
    const missing = () =>
      // @ts-expect-error minMs and maxMs are required
      supervise.restartWithBackoff({ minMs: 1 });
    expectTypeOf(missing).returns.toEqualTypeOf<SupervisorStrategy>();
  });

  it('adds preRestart to Signal, and failed and restarted to SystemEvent', () => {
    expectTypeOf<Extract<Signal, { type: 'preRestart' }>>().toEqualTypeOf<{
      readonly type: 'preRestart';
      readonly error: unknown;
    }>();
    type Failed = Extract<SystemEvent, { type: 'failed' }>;
    expectTypeOf<Failed['directive']>().toEqualTypeOf<'stop' | 'resume' | 'restart'>();
    type Restarted = Extract<SystemEvent, { type: 'restarted' }>;
    expectTypeOf<Restarted['attempt']>().toEqualTypeOf<number>();
    expectTypeOf<Restarted['delayMs']>().toEqualTypeOf<number>();
  });
});
