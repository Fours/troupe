// The box office on opening night: one persistent show per production, behind a box office that
// forwards each request to its show. Grown from examples/box-office, with sales tagged for the
// sales board.
import { actor, supervise, type ActorRef } from '@kylewillett/troupe';
import { persistentActor, type Persistence } from '@kylewillett/troupe/persistence';

/** Tonight's shows, by name, with their number of seats. */
export const SHOWS: Readonly<Record<string, number>> = {
  hamlet: 120,
  macbeth: 80,
  othello: 60,
  lear: 40,
};

/** How long a hold lasts before its seats go back on sale, in ms. */
export const HOLD_MS = 4_000;

/** The tag on every sale, which the sales board follows. */
export const SALE_TAG = 'sale';

/** Why a confirm fails when its hold has expired, or never was. */
export const NO_SUCH_HOLD = 'no such hold';

/** Why a return fails when the show has sold nothing. */
export const NOTHING_SOLD = 'nothing sold yet';

/** How a show is supervised. Each restart replays the journal, so it backs off. */
export const SHOW_BACKOFF = { minMs: 200, maxMs: 5_000 } as const;

// Replies say what they answer, so a message event that carries one tells the whole story.

/** The answer to a hold. */
export type HoldReply =
  | {
      kind: 'hold';
      ok: true;
      show: string;
      holdId: string;
      seats: number;
      expiresInMs: number;
    }
  | { kind: 'hold'; ok: false; show: string; reason: string };

/** The answer to a confirm. */
export type ConfirmReply =
  | { kind: 'confirm'; ok: true; show: string; seats: number; sold: number }
  | { kind: 'confirm'; ok: false; show: string; reason: string };

/** The answer to a return. `seats` can be fewer than asked, if fewer were sold. */
export type ReturnReply =
  | { kind: 'return'; ok: true; show: string; seats: number }
  | { kind: 'return'; ok: false; show: string; reason: string };

/** The answer to a status request: a show's seats right now. */
export type StatusReply =
  { ok: true; capacity: number; sold: number; held: number } | { ok: false; reason: string };

/** What customers send to the box office. Each request names its show. */
export type CustomerRequest =
  | { type: 'hold'; show: string; customer: string; seats: number; replyTo: ActorRef<HoldReply> }
  | { type: 'confirm'; show: string; holdId: string; replyTo: ActorRef<ConfirmReply> }
  | {
      type: 'return';
      show: string;
      customer: string;
      seats: number;
      replyTo: ActorRef<ReturnReply>;
    }
  | { type: 'status'; show: string; replyTo: ActorRef<StatusReply> };

/** What a show handles: customer requests, plus its own hold timers. */
export type ShowMsg = CustomerRequest | { type: 'expire'; holdId: string };

/** What a show remembers, in its journal. */
export type ShowEvent =
  | { type: 'held'; holdId: string; customer: string; seats: number }
  // Carries its seats, so the sales board needs no other event to count a sale.
  | { type: 'confirmed'; holdId: string; seats: number }
  | { type: 'released'; holdId: string }
  // A sale undone, so seats go back on sale and the night never stays sold out.
  | { type: 'returned'; customer: string; seats: number };

/** A show's state: plain data, rebuilt from its events. */
export interface ShowState {
  readonly sold: number;
  readonly holds: Readonly<Record<string, { customer: string; seats: number }>>;
  readonly nextId: number;
}

/** The seats on hold in `state`. */
export function heldSeats(state: ShowState): number {
  return Object.values(state.holds).reduce((sum, hold) => sum + hold.seats, 0);
}

/** The persistence id of the show called `name`. */
export const showId = (name: string): string => `show-${name}`;

/**
 * One show, with `capacity` seats, persisted as `show-<name>`. Holds expire after
 * {@link HOLD_MS} unless confirmed. A malformed hold throws, which hands it to supervision.
 */
export function show(name: string, capacity: number, persistence: Persistence) {
  return persistentActor<ShowMsg, ShowEvent, ShowState>({
    id: showId(name),
    persistence,
    initial: { sold: 0, holds: {}, nextId: 1 },
    onCommand: (state, msg, ctx) => {
      const { persist, reply, none } = ctx;
      switch (msg.type) {
        case 'hold': {
          if (!Number.isInteger(msg.seats) || msg.seats < 1) {
            throw new RangeError(`seats must be a positive integer, got ${String(msg.seats)}`);
          }
          const free = capacity - state.sold - heldSeats(state);
          if (msg.seats > free) {
            return reply(msg.replyTo, {
              kind: 'hold',
              ok: false,
              show: name,
              reason: free === 0 ? 'sold out' : `only ${String(free)} left`,
            });
          }
          const holdId = `${name}-${String(state.nextId)}`;
          return (
            persist({ type: 'held', holdId, customer: msg.customer, seats: msg.seats })
              // Started once the hold is written, so a failed write leaves no timer behind.
              .thenRun(() => {
                ctx.timers.startSingle(holdId, { type: 'expire', holdId }, HOLD_MS);
              })
              .thenReply(msg.replyTo, (): HoldReply => ({
                kind: 'hold',
                ok: true,
                show: name,
                holdId,
                seats: msg.seats,
                expiresInMs: HOLD_MS,
              }))
          );
        }
        case 'confirm': {
          const hold = state.holds[msg.holdId];
          if (hold === undefined) {
            return reply(msg.replyTo, {
              kind: 'confirm',
              ok: false,
              show: name,
              reason: NO_SUCH_HOLD,
            });
          }
          return (
            persist({ type: 'confirmed', holdId: msg.holdId, seats: hold.seats })
              .thenRun(() => {
                ctx.timers.cancel(msg.holdId);
              })
              // `sold` is what the show had sold once this sale was in, so a caller can tell a later
              // status that missed it.
              .thenReply(msg.replyTo, (after): ConfirmReply => ({
                kind: 'confirm',
                ok: true,
                show: name,
                seats: hold.seats,
                sold: after.sold,
              }))
          );
        }
        case 'return': {
          if (state.sold === 0) {
            return reply(msg.replyTo, {
              kind: 'return',
              ok: false,
              show: name,
              reason: NOTHING_SOLD,
            });
          }
          const seats = Math.min(msg.seats, state.sold);
          return persist({ type: 'returned', customer: msg.customer, seats }).thenReply(
            msg.replyTo,
            (): ReturnReply => ({ kind: 'return', ok: true, show: name, seats }),
          );
        }
        case 'status':
          return reply(msg.replyTo, {
            ok: true,
            capacity,
            sold: state.sold,
            held: heldSeats(state),
          });
        case 'expire':
          return msg.holdId in state.holds
            ? persist({ type: 'released', holdId: msg.holdId })
            : none();
      }
    },
    onEvent: (state, event) => {
      switch (event.type) {
        case 'held':
          return {
            ...state,
            holds: {
              ...state.holds,
              [event.holdId]: { customer: event.customer, seats: event.seats },
            },
            nextId: state.nextId + 1,
          };
        case 'confirmed':
          return {
            ...state,
            sold: state.sold + event.seats,
            holds: without(state.holds, event.holdId),
          };
        case 'released':
          return { ...state, holds: without(state.holds, event.holdId) };
        case 'returned':
          return { ...state, sold: state.sold - event.seats };
      }
    },
    // A return is a sale too, of minus its seats, so the sales board sees both.
    tags: (event) => (event.type === 'confirmed' || event.type === 'returned' ? [SALE_TAG] : []),
    onSignal: (state, signal, ctx) => {
      // Timers don't survive a restart, so each recovered hold gets a fresh one.
      if (signal.type !== 'recoveryCompleted') return;
      for (const holdId of Object.keys(state.holds)) {
        ctx.timers.startSingle(holdId, { type: 'expire', holdId }, HOLD_MS);
      }
    },
  });
}

/** Answers a request for a show that isn't on, so its customer isn't left waiting. */
export function unknownShow(msg: CustomerRequest): void {
  const reason = `no show "${msg.show}"`;
  switch (msg.type) {
    case 'hold':
      msg.replyTo.tell({ kind: 'hold', ok: false, show: msg.show, reason });
      return;
    case 'confirm':
      msg.replyTo.tell({ kind: 'confirm', ok: false, show: msg.show, reason });
      return;
    case 'return':
      msg.replyTo.tell({ kind: 'return', ok: false, show: msg.show, reason });
      return;
    case 'status':
      msg.replyTo.tell({ ok: false, reason });
  }
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

/**
 * Spawns a show for each of `shows` (name to capacity), each restarted with backoff, and forwards
 * every request to its show, which replies to the customer directly.
 */
export function boxOffice(shows: Readonly<Record<string, number>>, persistence: Persistence) {
  return actor<CustomerRequest, null>({
    initial: (ctx) => {
      for (const [name, capacity] of Object.entries(shows)) {
        ctx.spawn(show(name, capacity, persistence), name, {
          supervision: supervise.restartWithBackoff(SHOW_BACKOFF),
        });
      }
      return null;
    },
    receive: (state, msg, ctx) => {
      // Every child is a show.
      const target = ctx.child(msg.show) as ActorRef<ShowMsg> | undefined;
      if (target !== undefined) target.tell(msg);
      else unknownShow(msg);
      return state;
    },
  });
}
