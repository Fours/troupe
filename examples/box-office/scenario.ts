// The box office story. main.ts runs it on real time, and the example test runs it under the
// testkit, so the demo can't rot.
import type { ActorRef, ActorSystem, Result } from '@kylewillett/troupe';
import { boxOffice, HOLD_MS, type CustomerRequest } from './box-office.ts';
import type { Narrator } from './narrate.ts';

/** Where the scenario runs: a system, a way to let time pass, and someone to tell. */
export interface Stage {
  readonly system: ActorSystem;
  readonly narrator: Narrator;
  /** Lets `ms` pass, and everything due in that time happen. */
  sleep(ms: number): Promise<void>;
  /** Terminates the system and waits for every actor to stop. */
  shutdown(): Promise<void>;
}

/** The shows on sale, by name, with their number of seats. */
export const SHOWS = { hamlet: 4, macbeth: 2 };

export async function runScenario(stage: Stage): Promise<void> {
  const { system, narrator } = stage;
  const seats = (n: number) => `${String(n)} ${n === 1 ? 'seat' : 'seats'}`;
  const say = (line: string) => {
    narrator.say(line);
  };
  system.events.subscribe((event) => {
    narrator.event(event);
  });

  const office = system.spawn(boxOffice(SHOWS), 'box-office');

  /**
   * Asks the box office, then lets `waitMs` pass. The reply is turned into a Result at once, so a
   * timeout during the wait is never an unhandled rejection.
   */
  async function request<R>(
    build: (replyTo: ActorRef<R>) => CustomerRequest,
    opts: { timeoutMs?: number; waitMs?: number } = {},
  ): Promise<Result<R>> {
    const reply = office
      .ask<R>(build, opts.timeoutMs === undefined ? undefined : { timeoutMs: opts.timeoutMs })
      .then(
        (value): Result<R> => ({ ok: true, value }),
        (error: unknown): Result<R> => ({ ok: false, error }),
      );
    await stage.sleep(opts.waitMs ?? 0);
    return reply;
  }

  async function hold(customer: string, show: string, count: number): Promise<string | undefined> {
    say(`${customer} asks to hold ${seats(count)} for ${show}`);
    const reply = await request<{ ok: true; holdId: string } | { ok: false; reason: string }>(
      (replyTo) => ({ type: 'hold', show, customer, seats: count, replyTo }),
    );
    if (!reply.ok) throw reply.error;
    if (!reply.value.ok) {
      say(`${customer} is turned away: ${reply.value.reason}`);
      return undefined;
    }
    say(`${customer} holds ${reply.value.holdId} for ${String(HOLD_MS)} ms`);
    return reply.value.holdId;
  }

  async function confirm(customer: string, show: string, holdId: string): Promise<void> {
    say(`${customer} confirms ${holdId}`);
    const reply = await request<{ ok: true; seats: number } | { ok: false; reason: string }>(
      (replyTo) => ({ type: 'confirm', show, holdId, replyTo }),
    );
    if (!reply.ok) throw reply.error;
    say(
      reply.value.ok
        ? `${customer} bought ${seats(reply.value.seats)}`
        : `${customer} can't buy: ${reply.value.reason}`,
    );
  }

  await stage.sleep(0);

  // A hold that's confirmed in time.
  const alice = await hold('alice', 'hamlet', 2);
  if (alice !== undefined) await confirm('alice', 'hamlet', alice);

  // A hold that expires on its timer.
  const bob = await hold('bob', 'macbeth', 2);
  await hold('dave', 'macbeth', 1);
  say(`bob gets distracted for ${String(HOLD_MS + 100)} ms`);
  await stage.sleep(HOLD_MS + 100);
  if (bob !== undefined) await confirm('bob', 'macbeth', bob);
  await hold('dave', 'macbeth', 1);

  // A malformed request crashes the show, and its parent restarts it with backoff.
  const carol = await hold('carol', 'hamlet', 1);
  say('mallory sends a malformed request to hamlet, for -1 seats');
  const mallory = await request(
    (replyTo) => ({ type: 'hold', show: 'hamlet', customer: 'mallory', seats: -1, replyTo }),
    { timeoutMs: 500, waitMs: 600 },
  );
  say(mallory.ok ? 'mallory got a reply?' : `mallory never hears back: ${String(mallory.error)}`);

  // The restarted show is a new incarnation, with the initial state.
  if (carol !== undefined) await confirm('carol', 'hamlet', carol);
  say("hamlet's restart wiped its holds and sales. Persistent actors, in milestone 2, fix that.");

  await stage.shutdown();
  say('the box office is closed');
}
