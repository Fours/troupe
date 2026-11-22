// Opening night: the whole demo system, its storage and clock, and what the page's buttons do.
import {
  createActorSystem,
  type ActorRef,
  type ActorSystem,
  type Logger,
  type SystemEvent,
} from '@kylewillett/troupe';
import { inMemoryPersistence } from '@kylewillett/troupe/persistence';
import { ManualScheduler, seededRandom } from '@kylewillett/troupe/testkit';
import { DrivenClock, SettleError, type Speed } from './clock.ts';
import { crowd, RUSH_SIZE, type CrowdMsg } from './crowd.ts';
import { faultyPersistence, type FaultyPersistence } from './faulty-persistence.ts';
import { salesBoard, type BoardMsg } from './sales-board.ts';
import { boxOffice, SHOWS, type CustomerRequest, type StatusReply } from './shows.ts';

/** Options for {@link openingNight}. */
export interface OpeningNightOptions {
  /** Resolves after one turn of the event loop (see `DrivenClockOptions`). */
  readonly yieldToEventLoop: () => Promise<void>;
  /** The seed for every chance in the story. Default 1. */
  readonly seed?: number;
  /** Whether customers arrive on their own. Default true. Tests turn it off to count exactly. */
  readonly arrivals?: boolean;
  /** The speed to start at. Default 1. */
  readonly speed?: Speed;
  /** Where the systems log. Default: nowhere, since the page tells the story from events. */
  readonly logger?: Logger;
}

/** The demo, running. */
export interface OpeningNight {
  /** Moves virtual time, from the page's animation frames. */
  readonly clock: DrivenClock;
  /** The storage every system uses, and its switch. */
  readonly persistence: FaultyPersistence;
  /**
   * The system running now. A restart replaces it. It exists before its actors do, which spawn
   * in the clock's first turn, so an inspector can attach before anything happens.
   */
  readonly system: ActorSystem;
  /** Resolves once the first system's actors have spawned. */
  readonly started: Promise<void>;
  /** How many times the system has been restarted. */
  readonly generation: number;
  /** Calls `listener` with every event of this system and every later one, messages included. */
  subscribe(listener: (event: SystemEvent) => void): () => void;
  /**
   * Calls `listener` with the system now, and with each new one a restart makes, before its
   * actors spawn, so an inspector attached to it sees every spawn.
   */
  onSystem(listener: (system: ActorSystem) => void): () => void;
  // The buttons. Each runs in the clock's next turn, and resolves once it has.
  /** Sends {@link RUSH_SIZE} customers at once. */
  rush(): Promise<void>;
  /** Sends a hold for -1 seats to `show`, which throws, so supervision restarts it. */
  badRequest(show?: string): Promise<void>;
  /** Takes the journal down. */
  journalDown(): Promise<void>;
  /** Brings the journal back. */
  journalUp(): Promise<void>;
  /** Terminates the system and starts a new one on the same storage. */
  restart(): Promise<void>;
  /** Asks a show for its seats. It's answered as virtual time passes. */
  status(show: string): Promise<StatusReply>;
  /** Asks the sales board for seats sold per show. It's answered as virtual time passes. */
  totals(): Promise<Readonly<Record<string, number>>>;
  /** Terminates the system. */
  dispose(): Promise<void>;
}

/** The show a bad request goes to when none is chosen. */
export const DEFAULT_TARGET = 'hamlet';

const QUIET: Logger = { debug() {}, info() {}, warn() {}, error() {} };

// Each generation and each use gets its own stream of chance, all from the one seed.
const streamSeed = (seed: number, generation: number, stream: number): number =>
  seed * 1_000 + generation * 10 + stream;

interface Cast {
  readonly office: ActorRef<CustomerRequest>;
  readonly crowd: ActorRef<CrowdMsg>;
  readonly board: ActorRef<BoardMsg>;
}

/**
 * Opens the box office on a {@link ManualScheduler}, with seeded chance, so the same seed and the
 * same button presses at the same virtual times tell the same story. Nothing runs until the clock
 * moves.
 */
export function openingNight(opts: OpeningNightOptions): OpeningNight {
  const { seed = 1, arrivals = true, logger = QUIET } = opts;
  const scheduler = new ManualScheduler();
  const clock = new DrivenClock({
    scheduler,
    yieldToEventLoop: opts.yieldToEventLoop,
    speed: opts.speed ?? 1,
  });
  const persistence = faultyPersistence(() => scheduler.now());
  const listeners = new Set<(event: SystemEvent) => void>();
  const watchers = new Set<(system: ActorSystem) => void>();
  let generation = 0;

  const newSystem = (): ActorSystem => {
    const system = createActorSystem({
      name: 'opening-night',
      scheduler,
      random: seededRandom(streamSeed(seed, generation, 0)),
      logger,
    });
    system.events.subscribe(
      (event) => {
        for (const listener of listeners) listener(event);
      },
      { messages: true },
    );
    return system;
  };

  const cast = (system: ActorSystem): Cast => {
    const office = system.spawn(boxOffice(SHOWS, persistence), 'box-office');
    // Offsets of this system's own, so the board counts every sale again (see salesBoard).
    const offsets = inMemoryPersistence().offsets;
    const board = system.spawn(
      salesBoard({ journal: persistence.journal, offsets }),
      'sales-board',
    );
    const people = system.spawn(
      crowd({
        office,
        shows: Object.keys(SHOWS),
        random: seededRandom(streamSeed(seed, generation, 1)),
        arrivals,
      }),
      'crowd',
    );
    return { office, crowd: people, board };
  };

  // The system exists at once, so an inspector can attach before anything spawns. Its actors
  // spawn in the clock's first turn.
  let system = newSystem();
  let actors: Cast | undefined;
  const started = clock.run(() => {
    actors = cast(system);
    return Promise.resolve();
  });
  // Every press runs in the clock's turn, between due times, never in the middle of a settle,
  // so where it lands in the story depends only on the virtual time.
  const press = (task: (cast: Cast) => void): Promise<void> =>
    clock.run(() => {
      // Set by the first turn, which runs before any press.
      if (actors !== undefined) task(actors);
      return Promise.resolve();
    });
  // An ask, made in the clock's turn and answered as time passes. Wrapped, so the clock's turn
  // ends as soon as the ask is sent, rather than waiting for its answer.
  const query = <T>(ask: (cast: Cast) => Promise<T>): Promise<T> =>
    clock
      .run(() => {
        if (actors === undefined) throw new Error('opening night has not started');
        return Promise.resolve({ answer: ask(actors) });
      })
      .then(({ answer }) => answer);

  return {
    clock,
    persistence,
    started,
    get system() {
      return system;
    },
    get generation() {
      return generation;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onSystem(listener) {
      watchers.add(listener);
      listener(system);
      return () => {
        watchers.delete(listener);
      };
    },
    rush: () =>
      press(({ crowd: people }) => {
        people.tell({ type: 'rush', count: RUSH_SIZE });
      }),
    badRequest: (show = DEFAULT_TARGET) =>
      press(({ office }) => {
        // Nobody waits for the answer, since there won't be one: the show throws.
        office
          .ask<unknown>(
            (replyTo) => ({ type: 'hold', show, customer: 'mallory', seats: -1, replyTo }),
            { timeoutMs: 1_000 },
          )
          .catch(() => undefined);
      }),
    journalDown: () =>
      press(() => {
        persistence.down();
      }),
    journalUp: () =>
      press(() => {
        persistence.up();
      }),
    restart: () =>
      // One turn, so time doesn't pass while one system stops and the next starts.
      clock.run(async ({ settle }) => {
        await settleUntil(system.terminate(), settle);
        generation++;
        system = newSystem();
        for (const watcher of watchers) watcher(system);
        actors = cast(system);
      }),
    status: (show) =>
      query(({ office }) =>
        office.ask<StatusReply>((replyTo) => ({ type: 'status', show, replyTo })),
      ),
    totals: () => query(({ board }) => board.ask((replyTo) => ({ type: 'totals', replyTo }))),
    dispose: () => clock.run(({ settle }) => settleUntil(system.terminate(), settle)),
  };
}

// Settles until `promise` resolves. Terminating needs no time to pass, only settling, and each
// settle already waits out many turns of the event loop, so a few are plenty.
async function settleUntil(promise: Promise<void>, settle: () => Promise<void>): Promise<void> {
  // An object, since TypeScript can't see the callback change a plain local.
  const stopped = { done: false };
  void promise.then(() => {
    stopped.done = true;
  });
  for (let i = 0; i < 10 && !stopped.done; i++) await settle();
  if (!stopped.done) throw new SettleError('the system did not stop without time passing');
  await promise;
}
