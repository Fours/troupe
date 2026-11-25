// Type tests: `npm run typecheck` checks these, since it type-checks test/. At runtime the
// assertions do nothing, and @ts-expect-error lines fail the typecheck if they stop being errors.
import * as testkit from '@kylewillett/troupe/testkit';
import { describe, expectTypeOf, it } from 'vitest';
import { actor } from '../src/actor.js';
import { supervise, type SupervisorStrategy } from '../src/supervision.js';
import type {
  ActorContext,
  ActorDef,
  ActorRef,
  ActorSystem,
  AnyRef,
  DeadLetterReason,
  PipeOptions,
  PipeSignal,
  Result,
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
    const ref = {} as ActorRef<A>;
    // Never called: the type error is the point.
    const wrong = () => {
      // @ts-expect-error B isn't in the protocol
      ref.tell({ type: 'b' });
    };
    expectTypeOf(wrong).returns.toBeVoid();
    expectTypeOf<ActorRef<A>['tell']>().parameter(0).toEqualTypeOf<A>();
  });
});

describe('ask', () => {
  type Get = { type: 'get'; replyTo: ActorRef<number> };
  type Protocol = Get | { type: 'inc'; by: number };
  // Never called: the types are the point.
  const ref = {} as ActorRef<Protocol>;

  it('takes the reply type as an argument, or from an annotated replyTo', () => {
    const explicit = () => ref.ask<number>((replyTo) => ({ type: 'get', replyTo }));
    expectTypeOf(explicit).returns.toEqualTypeOf<Promise<number>>();
    const annotated = () => ref.ask((replyTo: ActorRef<number>) => ({ type: 'get', replyTo }));
    expectTypeOf(annotated).returns.toEqualTypeOf<Promise<number>>();
    // The protocol alone gives nothing to infer R from, which is why the docs say to pass it.
    const bare = () => ref.ask((replyTo) => ({ type: 'get', replyTo }));
    expectTypeOf(bare).returns.toEqualTypeOf<Promise<unknown>>();
  });

  it('rejects a reply type the protocol does not expect', () => {
    // @ts-expect-error a get carries an ActorRef<number>, not an ActorRef<string>
    const wrong = () => ref.ask<string>((replyTo) => ({ type: 'get', replyTo }));
    expectTypeOf(wrong).returns.toEqualTypeOf<Promise<string>>();
    // @ts-expect-error build must return a message of the protocol
    const notAMessage = () => ref.ask<number>(() => ({ type: 'other' }));
    expectTypeOf(notAMessage).returns.toEqualTypeOf<Promise<number>>();
  });

  it('keeps ActorRef contravariant and assignable to AnyRef', () => {
    expectTypeOf<ActorRef<Protocol>>().toExtend<ActorRef<Get>>();
    expectTypeOf<ActorRef<Get>>().not.toExtend<ActorRef<Protocol>>();
    expectTypeOf<ActorRef<Protocol>>().toExtend<AnyRef>();
  });
});

describe('timers and pipeToSelf', () => {
  it("only accept messages of the actor's protocol", () => {
    const ctx = {} as ActorContext<A>;
    expectTypeOf<ActorContext<A>['timers']['startSingle']>().parameter(1).toEqualTypeOf<A>();
    expectTypeOf<ActorContext<A>['timers']['startPeriodic']>().parameter(1).toEqualTypeOf<A>();
    const pipe = () => {
      ctx.pipeToSelf(Promise.resolve(1), (result) => {
        expectTypeOf(result).toEqualTypeOf<Result<number>>();
        return { type: 'a' };
      });
      // @ts-expect-error the mapper must return a message of the protocol
      ctx.pipeToSelf(Promise.resolve(1), () => ({ type: 'b' }));
    };
    expectTypeOf(pipe).returns.toBeVoid();
  });

  it("take any runtime's AbortSignal as a signal, and nothing else", () => {
    expectTypeOf<AbortSignal>().toExtend<PipeSignal>();
    expectTypeOf<PipeOptions['signal']>().toEqualTypeOf<PipeSignal | undefined>();
    const ctx = {} as ActorContext<A>;
    const pipe = () => {
      ctx.pipeToSelf(Promise.resolve(1), () => ({ type: 'a' }), {
        signal: new AbortController().signal,
      });
      // @ts-expect-error a signal needs aborted, reason and the listener methods
      ctx.pipeToSelf(Promise.resolve(1), () => ({ type: 'a' }), { signal: { aborted: false } });
    };
    expectTypeOf(pipe).returns.toBeVoid();
  });

  it('narrows a Result on ok', () => {
    const result = {} as Result<number>;
    if (result.ok) expectTypeOf(result.value).toEqualTypeOf<number>();
    else expectTypeOf(result.error).toEqualTypeOf<unknown>();
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

  it('types minDelayFor as a reader of an unknown failure that returns ms or undefined', () => {
    type Opts = Parameters<typeof supervise.restartWithBackoff>[0];
    expectTypeOf<NonNullable<Opts['minDelayFor']>>().toEqualTypeOf<
      (failure: unknown) => number | undefined
    >();
    // A reader that narrows the failure itself fits, as one that always answers does.
    expectTypeOf((failure: unknown) => (failure instanceof Error ? 5000 : undefined)).toExtend<
      NonNullable<Opts['minDelayFor']>
    >();
    expectTypeOf(() => 5000).toExtend<NonNullable<Opts['minDelayFor']>>();
    // Never called. A reader that needs an Error can't be given every failure.
    const narrow = () =>
      supervise.restartWithBackoff({
        minMs: 1,
        maxMs: 2,
        // @ts-expect-error the failure is unknown, not an Error
        minDelayFor: (e: Error) => e.name.length,
      });
    expectTypeOf(narrow).returns.toEqualTypeOf<SupervisorStrategy>();
    const stringly = () =>
      // @ts-expect-error a delay is a number of ms
      supervise.restartWithBackoff({ minMs: 1, maxMs: 2, minDelayFor: () => '5s' });
    expectTypeOf(stringly).returns.toEqualTypeOf<SupervisorStrategy>();
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

  it('adds askCompleted, and the cluster’s reasons, to the dead-letter reasons', () => {
    type DeadLetter = Extract<SystemEvent, { type: 'deadLetter' }>;
    expectTypeOf<DeadLetter['reason']>().toEqualTypeOf<
      | 'mailboxFull'
      | 'stopped'
      | 'askCompleted'
      | 'terminated'
      | 'unreachable'
      | 'unserializable'
      | 'invalid'
    >();
    expectTypeOf<DeadLetter['reason']>().toEqualTypeOf<DeadLetterReason>();
  });
});

describe('message events', () => {
  it('narrow by type, with an optional sender and skipped flag', () => {
    type Delivered = Extract<SystemEvent, { type: 'delivered' }>;
    type Processed = Extract<SystemEvent, { type: 'processed' }>;
    expectTypeOf<Delivered['id']>().toEqualTypeOf<number>();
    expectTypeOf<Delivered['from']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Delivered['message']>().toEqualTypeOf<unknown>();
    expectTypeOf<Delivered['depth']>().toEqualTypeOf<number>();
    expectTypeOf<Processed['durationMs']>().toEqualTypeOf<number>();
    expectTypeOf<Processed['skipped']>().toEqualTypeOf<true | undefined>();
    expectTypeOf<Processed['stateChanged']>().toEqualTypeOf<boolean>();
    type DeadLetter = Extract<SystemEvent, { type: 'deadLetter' }>;
    expectTypeOf<DeadLetter['id']>().toEqualTypeOf<number | undefined>();
  });

  it('are asked for with an optional messages flag', () => {
    type Subscribe = ActorSystem['events']['subscribe'];
    expectTypeOf<Parameters<Subscribe>[1]>().toEqualTypeOf<{ messages?: boolean } | undefined>();
    // Never called: only the typecheck reads it.
    const misuse = (system: ActorSystem) => {
      // @ts-expect-error messages is a boolean
      system.events.subscribe(() => {}, { messages: 1 });
      // @ts-expect-error no other options
      system.events.subscribe(() => {}, { message: true });
    };
    expectTypeOf(misuse).toBeFunction();
  });
});

describe('the testkit entry point', () => {
  it('exports TestProbe as a type only, so probes come from kit.probe()', () => {
    const probe = () => testkit.createTestKit().probe<A>();
    expectTypeOf(probe).returns.toEqualTypeOf<testkit.TestProbe<A>>();
    // The arguments are valid, so the only error is that TestProbe has no value. Lint can't type
    // what doesn't resolve, which is the point.
    /* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return,
       @typescript-eslint/no-unnecessary-type-assertion */
    const construct = () =>
      // @ts-expect-error TestProbe is exported with `export type`, so it has no value to call.
      new testkit.TestProbe<A>('/temp/probe-x', 'probe-x', {} as never);
    /* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return,
       @typescript-eslint/no-unnecessary-type-assertion */
    expectTypeOf(construct).toBeFunction();
  });
});
