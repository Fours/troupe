// Type tests for persistent actors: `npm run typecheck` checks these. At runtime the assertions do
// nothing, and @ts-expect-error lines fail the typecheck if they stop being errors.
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { persistentActor } from '../../src/persistence/actor.js';
import type { Effect, PersistentContext, PersistentState } from '../../src/persistence/actor.js';
import { inMemoryPersistence } from '../../src/persistence/memory.js';
import { projection, type ProjectionState } from '../../src/persistence/projection.js';
import type { StoredEvent } from '../../src/persistence/types.js';
import { createActorSystem } from '../../src/system.js';
import type { ActorDef, ActorRef } from '../../src/types.js';

type Cmd =
  | { type: 'add'; n: number; replyTo: ActorRef<number> }
  | { type: 'get'; replyTo: ActorRef<number> };
type Ev = { type: 'added'; n: number };
interface Total {
  total: number;
}

const persistence = inMemoryPersistence({ clock: () => 0 });

describe('persistentActor types', () => {
  it('infers C, E and S from the definition', () => {
    const def = persistentActor({
      id: 'total',
      persistence,
      initial: { total: 0 },
      onCommand(state, cmd: Cmd, { persist, reply }) {
        expectTypeOf(state).toEqualTypeOf<Total>();
        return cmd.type === 'add'
          ? persist({ type: 'added', n: cmd.n }).thenReply(cmd.replyTo, (s) => s.total)
          : reply(cmd.replyTo, state.total);
      },
      onEvent: (state, event: Ev) => ({ total: state.total + event.n }),
    });
    expectTypeOf(def).toEqualTypeOf<ActorDef<Cmd, PersistentState<Total>>>();
  });

  it('is spawnable as an ActorRef of its commands', () => {
    const def = persistentActor<Cmd, Ev, Total>({
      id: 'total',
      persistence,
      initial: { total: 0 },
      onCommand: (_s, _c, { none }) => none(),
      onEvent: (s) => s,
    });
    const system = createActorSystem();
    const ref = system.spawn(def);
    expectTypeOf(ref).toEqualTypeOf<ActorRef<Cmd>>();
    void system.terminate();
  });

  it('types the builders by the definition', () => {
    // Never called: only the types matter here.
    const check = (ctx: PersistentContext<Cmd, Ev, Total>) => {
      expectTypeOf(ctx.persist).parameters.toEqualTypeOf<Ev[]>();
      expectTypeOf(ctx.persist({ type: 'added', n: 1 })).toEqualTypeOf<Effect<Ev, Total>>();
      // @ts-expect-error persist takes only the definition's events
      ctx.persist({ type: 'removed', n: 1 });
      // @ts-expect-error nor a field its event doesn't have
      ctx.persist({ type: 'added', n: 1, extra: true });

      const numbers = {} as ActorRef<number>;
      ctx.reply(numbers, 1);
      // @ts-expect-error reply checks the message against the ref's type
      ctx.reply(numbers, 'one');

      ctx.none().thenReply(numbers, (s) => {
        expectTypeOf(s).toEqualTypeOf<Total>();
        return s.total;
      });
      // @ts-expect-error thenReply's message must suit the ref
      ctx.none().thenReply(numbers, (s) => String(s.total));
      ctx.none().thenRun((s) => {
        expectTypeOf(s).toEqualTypeOf<Total>();
      });
      expectTypeOf(ctx.lastSeq).toEqualTypeOf<number>();
      expectTypeOf(ctx.persistenceId).toEqualTypeOf<string>();
    };
    expectTypeOf(check).toBeFunction();
  });

  it('rejects an onCommand that returns a state instead of an effect', () => {
    persistentActor<Cmd, Ev, Total>({
      id: 'total',
      persistence,
      initial: { total: 0 },
      // @ts-expect-error state changes only through events (decision 0012)
      onCommand: (state) => state,
      onEvent: (s) => s,
    });
  });

  it('keeps an effect for one event type from standing in for another', () => {
    expectTypeOf<Effect<Ev, Total>>().not.toExtend<Effect<{ type: 'other' }, Total>>();
  });

  it('infers E from a schema, and rejects a schema for other events', () => {
    const added = z.object({ type: z.literal('added'), n: z.number() });
    const def = persistentActor({
      id: 'total',
      persistence,
      initial: { total: 0 },
      events: { schema: added },
      onCommand(_state, cmd: Cmd, { persist, none }) {
        expectTypeOf(persist).parameters.toEqualTypeOf<{ type: 'added'; n: number }[]>();
        return cmd.type === 'add' ? persist({ type: 'added', n: cmd.n }) : none();
      },
      onEvent(state, event) {
        expectTypeOf(event).toEqualTypeOf<{ type: 'added'; n: number }>();
        return { total: state.total + event.n };
      },
    });
    expectTypeOf(def).toEqualTypeOf<ActorDef<Cmd, PersistentState<Total>>>();

    persistentActor<Cmd, Ev, Total>({
      id: 'total',
      persistence,
      initial: { total: 0 },
      // @ts-expect-error the schema's output must be the definition's events
      events: { schema: z.object({ type: z.literal('removed'), n: z.number() }) },
      onCommand: (_s, _c, { none }) => none(),
      onEvent: (s) => s,
    });
  });

  it('passes tags() the event type', () => {
    persistentActor<Cmd, Ev, Total>({
      id: 'total',
      persistence,
      initial: { total: 0 },
      onCommand: (_state, _cmd, { none }) => none(),
      onEvent: (state, event) => ({ total: state.total + event.n }),
      tags(event) {
        expectTypeOf(event).toEqualTypeOf<Ev>();
        return ['total'];
      },
    });
  });
});

describe('projection types', () => {
  it('is an actor that takes no messages, and hands handle stored events', () => {
    const def = projection({
      name: 'totals',
      persistence,
      tag: 'total',
      handle(event) {
        expectTypeOf(event).toEqualTypeOf<StoredEvent>();
      },
    });
    expectTypeOf(def).toEqualTypeOf<ActorDef<never, ProjectionState>>();
    // Never called: spawning would start a projection on the real scheduler.
    const spawn = () => {
      const ref = createActorSystem().spawn(def);
      expectTypeOf(ref).toEqualTypeOf<ActorRef<never>>();
      // @ts-expect-error nothing outside can tell a projection anything
      ref.tell({ type: 'poll' });
    };
    expectTypeOf(spawn).toBeFunction();
  });
});
