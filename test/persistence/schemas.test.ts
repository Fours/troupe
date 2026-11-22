import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { persistentActor, type EventOptions } from '../../src/persistence/actor.js';
import { EventValidationError, EventVersionError } from '../../src/persistence/errors.js';
import { inMemoryPersistence } from '../../src/persistence/memory.js';
import type { StandardSchemaV1 } from '../../src/persistence/standard-schema.js';
import type { NewEvent, Persistence } from '../../src/persistence/types.js';
import { supervise } from '../../src/supervision.js';
import { createTestKit, type TestKit } from '../../src/testkit/kit.js';
import type { ActorRef, SystemEvent } from '../../src/types.js';
import { faultyJournal } from '../helpers/faulty-journal.js';

const ID = 'wallet-1';

/** A clock for the journal's timestamps, so nothing reads the wall clock. */
const clock = () => 1_000;

/** The current (version 2) event. Version 1 had no currency: every deposit was in USD. */
interface Deposit {
  type: 'deposited';
  amount: number;
  currency: string;
}

type Balances = Readonly<Record<string, number>>;

type WalletCmd =
  // Persists whatever it's given, so tests can try events the schema rejects.
  | { type: 'persist'; events: readonly unknown[]; replyTo: ActorRef<Balances> }
  | { type: 'balances'; replyTo: ActorRef<Balances> };

const v2 = z.object({
  type: z.literal('deposited'),
  amount: z.number().positive(),
  currency: z.string().length(3),
});

const toV2 = (event: unknown) => ({ ...(event as object), currency: 'USD' });

/** A wallet that sums deposits by currency, with the given event options. */
function wallet(persistence: Persistence, events: EventOptions<Deposit>) {
  return persistentActor<WalletCmd, Deposit, Balances>({
    id: ID,
    persistence,
    events,
    initial: {},
    onCommand(state, cmd, { persist, reply }) {
      switch (cmd.type) {
        case 'persist':
          // Tests persist events the types forbid, on purpose.
          return persist(...(cmd.events as Deposit[])).thenReply(cmd.replyTo, (s) => s);
        case 'balances':
          return reply(cmd.replyTo, state);
      }
    },
    onEvent: (state, e) => ({ ...state, [e.currency]: (state[e.currency] ?? 0) + e.amount }),
  });
}

function setup() {
  const store = inMemoryPersistence({ clock });
  const journal = faultyJournal(store.journal);
  const persistence: Persistence = { journal };
  const kit = createTestKit();
  const balances = kit.probe<Balances>('balances');
  // The default strategy stops, since a start that always fails would restart for ever.
  const spawn = (events: EventOptions<Deposit>, restart = false) =>
    kit.system.spawn(
      wallet(persistence, events),
      'wallet',
      restart ? { supervision: supervise.restart() } : undefined,
    );
  /** Writes events straight to the journal, as an older deployment would have. */
  const seed = (version: number, ...events: unknown[]) =>
    store.journal.append(
      ID,
      store.events(ID).length,
      events.map((event): NewEvent => ({ event, version, tags: [] })),
    );
  return { store, journal, kit, balances, spawn, seed };
}

const failures = (kit: TestKit) =>
  kit.events
    .filter((e): e is Extract<SystemEvent, { type: 'failed' }> => e.type === 'failed')
    .map((e) => e.error);

const usd = (amount: number) => ({ type: 'deposited', amount, currency: 'USD' });

/** A hand-written schema that only ever answers asynchronously. */
const asyncSchema: StandardSchemaV1<unknown, Deposit> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    async validate(value) {
      await Promise.resolve();
      const parsed = v2.safeParse(value);
      // The same rules as zodAsync below, so the two run the same cases.
      return parsed.success && parsed.data.amount < 1_000
        ? { value: parsed.data }
        : { issues: [{ message: 'not a deposit', path: ['amount'] }] };
    },
  },
};

/** Zod with an async refinement, so its `~standard.validate` returns a promise. */
const zodAsync = v2.refine(async (e) => {
  await Promise.resolve();
  return e.amount < 1_000;
}, 'amount must be under 1000');

describe('event schemas', () => {
  it('rejects a bad event on write, before the append, with the schema’s issues', async () => {
    const { store, journal, kit, balances, spawn } = setup();
    const ref = spawn({ schema: v2 }, true);
    ref.tell({ type: 'persist', events: [usd(5), usd(-1)], replyTo: balances.ref });
    await kit.settle();

    const [error] = failures(kit);
    expect(error).toBeInstanceOf(EventValidationError);
    expect(error).toMatchObject({ name: 'EventValidationError', persistenceId: ID });
    const { seq, issues } = error as EventValidationError;
    expect(seq).toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(['amount']);
    // The first event was fine, but the batch is all or none, and nothing reached the journal.
    expect(journal.appends).toEqual([]);
    expect(store.events(ID)).toEqual([]);
    expect(balances.messages()).toEqual([]);

    // The restarted actor carries on.
    ref.tell({ type: 'persist', events: [usd(5)], replyTo: balances.ref });
    await kit.settle();
    balances.expectMessage({ USD: 5 });
    await kit.shutdown();
  });

  it('rejects a bad stored event on recovery, naming its sequence number', async () => {
    const { kit, spawn, seed } = setup();
    await seed(2, usd(5), { type: 'deposited', amount: 1, currency: 'dollars' });
    spawn({ schema: v2, version: 2, upcasters: { 1: toV2 } });
    await kit.settle();

    const [error] = failures(kit);
    expect(error).toBeInstanceOf(EventValidationError);
    expect(error).toMatchObject({ persistenceId: ID, seq: 2 });
    expect((error as EventValidationError).issues[0]?.path).toEqual(['currency']);
    expect((error as Error).message).toMatch(/^event 2 of "wallet-1" failed its schema: /);
    await kit.shutdown();
  });

  it('stores the event as persist got it, and folds the schema’s output', async () => {
    const { store, kit, balances, spawn } = setup();
    // A schema that fills in a default: the stored event stays an input it can check again.
    const schema = z.object({
      type: z.literal('deposited'),
      amount: z.number(),
      currency: z.string().default('EUR'),
    });
    const ref = spawn({ schema });
    ref.tell({
      type: 'persist',
      events: [{ type: 'deposited', amount: 3 }],
      replyTo: balances.ref,
    });
    await kit.settle();
    balances.expectMessage({ EUR: 3 });
    expect(store.events(ID).map((e) => e.event)).toEqual([{ type: 'deposited', amount: 3 }]);

    // Recovery folds the same output.
    const next = createTestKit();
    const probe = next.probe<Balances>();
    const again = next.system.spawn(wallet({ journal: store.journal }, { schema }), 'wallet');
    again.tell({ type: 'balances', replyTo: probe.ref });
    await next.settle();
    probe.expectMessage({ EUR: 3 });
    await kit.shutdown();
    await next.shutdown();
  });

  describe.each([
    ['a hand-written async schema', asyncSchema],
    ['Zod with an async refinement', zodAsync],
  ])('%s', (_name, schema) => {
    it('answers with a promise', () => {
      expect(schema['~standard'].validate(usd(1))).toBeInstanceOf(Promise);
    });

    it('accepts good events and rejects bad ones on write', async () => {
      const { store, journal, kit, balances, spawn } = setup();
      const ref = spawn({ schema }, true);
      ref.tell({ type: 'persist', events: [usd(5)], replyTo: balances.ref });
      ref.tell({ type: 'persist', events: [usd(5_000)], replyTo: balances.ref });
      ref.tell({ type: 'balances', replyTo: balances.ref });
      await kit.settle();

      balances.expectMessage({ USD: 5 });
      balances.expectMessage({ USD: 5 });
      expect(failures(kit).map((e) => e instanceof EventValidationError)).toEqual([true]);
      expect(journal.appends).toHaveLength(1);
      expect(store.events(ID).map((e) => e.event)).toEqual([usd(5)]);
      await kit.shutdown();
    });

    it('accepts good events and rejects bad ones on recovery', async () => {
      const { kit, balances, spawn, seed } = setup();
      await seed(1, usd(5), usd(7));
      const ref = spawn({ schema });
      ref.tell({ type: 'balances', replyTo: balances.ref });
      await kit.settle();
      balances.expectMessage({ USD: 12 });
      expect(failures(kit)).toEqual([]);
      await kit.shutdown();

      const bad = setup();
      await bad.seed(1, usd(5), usd(5_000));
      bad.spawn({ schema });
      await bad.kit.settle();
      expect(failures(bad.kit)).toHaveLength(1);
      expect(failures(bad.kit)[0]).toMatchObject({ name: 'EventValidationError', seq: 2 });
      await bad.kit.shutdown();
    });
  });
});

describe('event versions and upcasters', () => {
  it('upcasts a version-1 event to version 2, and stores new events at version 2', async () => {
    const { store, kit, balances, spawn, seed } = setup();
    await seed(1, { type: 'deposited', amount: 5 }, { type: 'deposited', amount: 2 });
    const upcast: unknown[] = [];
    const ref = spawn({
      schema: v2,
      version: 2,
      upcasters: {
        1: (event) => {
          upcast.push(event);
          return toV2(event);
        },
      },
    });
    ref.tell({ type: 'balances', replyTo: balances.ref });
    ref.tell({
      type: 'persist',
      events: [{ type: 'deposited', amount: 4, currency: 'EUR' }],
      replyTo: balances.ref,
    });
    await kit.settle();

    // Without the upcaster, the version-2 schema would reject both stored events.
    expect(failures(kit)).toEqual([]);
    expect(upcast).toEqual([
      { type: 'deposited', amount: 5 },
      { type: 'deposited', amount: 2 },
    ]);
    balances.expectMessage({ USD: 7 });
    balances.expectMessage({ USD: 7, EUR: 4 });
    // Old events keep their stored version: upcasting happens on every read, never in place.
    expect(store.events(ID).map((e) => [e.seq, e.version])).toEqual([
      [1, 1],
      [2, 1],
      [3, 2],
    ]);
    await kit.shutdown();
  });

  it('runs each upcaster from the stored version up, in order', async () => {
    const { kit, balances, spawn, seed } = setup();
    await seed(1, { type: 'deposited', amount: 5 });
    await seed(2, { type: 'deposited', amount: 3, currency: 'EUR' });
    await seed(3, { type: 'deposited', amount: 1, currency: 'EUR' });
    const calls: string[] = [];
    // Version 3 counts amounts in cents.
    const ref = spawn({
      version: 3,
      upcasters: {
        1: (event) => {
          calls.push('1→2');
          return toV2(event);
        },
        2: (event) => {
          calls.push('2→3');
          const e = event as Deposit;
          return { ...e, amount: e.amount * 100 };
        },
      },
    });
    ref.tell({ type: 'balances', replyTo: balances.ref });
    await kit.settle();

    expect(calls).toEqual(['1→2', '2→3', '2→3']);
    balances.expectMessage({ USD: 500, EUR: 301 });
    await kit.shutdown();
  });

  it('fails recovery with EventVersionError for a version above the current one', async () => {
    const { kit, balances, spawn, seed } = setup();
    await seed(2, usd(5));
    await seed(3, usd(1));
    const ref = spawn({ schema: v2, version: 2, upcasters: { 1: toV2 } });
    ref.tell({ type: 'balances', replyTo: balances.ref });
    await kit.settle();

    const [error] = failures(kit);
    expect(error).toBeInstanceOf(EventVersionError);
    expect(error).toMatchObject({
      name: 'EventVersionError',
      persistenceId: ID,
      seq: 2,
      version: 3,
    });
    expect((error as Error).message).toBe(
      'event 2 of "wallet-1" has version 3, newer than this actor\'s 2',
    );
    expect(balances.messages()).toEqual([]);
    await kit.shutdown();
  });

  it('fails recovery for a stored version below 1, which no upcaster covers', async () => {
    const { journal, kit, spawn, seed } = setup();
    await seed(1, { type: 'deposited', amount: 5 });
    journal.editNextRead((events) => events.map((e) => ({ ...e, version: 0 })));
    spawn({ version: 2, upcasters: { 1: toV2 } });
    await kit.settle();

    const [error] = failures(kit);
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toMatch(/event 1 has version 0, which no upcaster covers/);
    await kit.shutdown();
  });
});

describe('event option checks', () => {
  const persistence = inMemoryPersistence({ clock });
  const define = (events: unknown) => () => wallet(persistence, events as EventOptions<Deposit>);
  const noop = (event: unknown) => event;

  it('accepts complete upcasters, and none at version 1', () => {
    expect(define({})).not.toThrow();
    expect(define({ version: 1, upcasters: {} })).not.toThrow();
    expect(define({ version: 3, upcasters: { 1: noop, 2: noop } })).not.toThrow();
    expect(define({ schema: asyncSchema, version: 2, upcasters: { 1: noop } })).not.toThrow();
  });

  it.each([
    ['upcasters with a gap', { version: 4, upcasters: { 1: noop, 3: noop } }, /version 2/],
    ['a version above 1 with no upcasters', { version: 2 }, /cover versions 1 to 1/],
    ['an upcaster at the current version', { version: 2, upcasters: { 1: noop, 2: noop } }, /"2"/],
    ['an upcaster from version 0', { version: 2, upcasters: { 0: noop, 1: noop } }, /"0"/],
    ['a key that isn’t an integer', { version: 2, upcasters: { 1: noop, '1.5': noop } }, /"1.5"/],
    ['an upcaster that isn’t a function', { version: 2, upcasters: { 1: 'up' } }, /version 1/],
    ['upcasters that aren’t an object', { version: 2, upcasters: [noop] }, /must be an object/],
    ['a version of 0', { version: 0 }, /events.version must be a positive integer/],
    ['a version that isn’t an integer', { version: 1.5 }, /events.version/],
    ['a schema without ~standard', { schema: (v: unknown) => v }, /Standard Schema/],
    ['a schema without validate', { schema: { '~standard': {} } }, /Standard Schema/],
    ['an unknown field', { versions: 2 }, /unknown option "versions"/],
    ['events that aren’t an object', 2, /events: options must be an object/],
  ])('throws TypeError for %s', (_name, events, message) => {
    expect(define(events)).toThrow(TypeError);
    expect(define(events)).toThrow(message);
  });
});
