// The box office's actors: one BoxOffice, with one Show child per show.
import { actor, supervise, type ActorRef } from '@kylewillett/troupe';

/** How long a hold lasts before its seats go back on sale, in ms. */
export const HOLD_MS = 1000;

/** The answer to a hold. */
export type HoldReply =
  { ok: true; holdId: string; expiresInMs: number } | { ok: false; reason: string };

/** The answer to a confirm. */
export type ConfirmReply = { ok: true; seats: number } | { ok: false; reason: string };

/** What customers send to the box office. Each request names the show it's for. */
export type CustomerRequest =
  | { type: 'hold'; show: string; customer: string; seats: number; replyTo: ActorRef<HoldReply> }
  | { type: 'confirm'; show: string; holdId: string; replyTo: ActorRef<ConfirmReply> };

/** What a show handles: customer requests, plus its own hold timers. */
export type ShowMsg = CustomerRequest | { type: 'expire'; holdId: string };

/** A show's state: plain data, so milestone 2 can persist it as it is. */
interface ShowState {
  readonly sold: number;
  readonly holds: Readonly<Record<string, { customer: string; seats: number }>>;
  readonly nextId: number;
}

function heldSeats(state: ShowState): number {
  return Object.values(state.holds).reduce((sum, hold) => sum + hold.seats, 0);
}

/** One show, with `capacity` seats. Holds expire after {@link HOLD_MS} unless confirmed. */
export function show(name: string, capacity: number) {
  return actor<ShowMsg, ShowState>({
    initial: { sold: 0, holds: {}, nextId: 1 },
    receive: (state, msg, ctx) => {
      switch (msg.type) {
        case 'hold': {
          // A malformed request is a bug in the caller. Throwing hands it to supervision.
          if (!Number.isInteger(msg.seats) || msg.seats < 1) {
            throw new RangeError(`seats must be a positive integer, got ${String(msg.seats)}`);
          }
          const free = capacity - state.sold - heldSeats(state);
          if (msg.seats > free) {
            msg.replyTo.tell({
              ok: false,
              reason: free === 0 ? 'sold out' : `only ${String(free)} left`,
            });
            return state;
          }
          const holdId = `${name}-${String(state.nextId)}`;
          ctx.timers.startSingle(holdId, { type: 'expire', holdId }, HOLD_MS);
          msg.replyTo.tell({ ok: true, holdId, expiresInMs: HOLD_MS });
          return {
            ...state,
            holds: { ...state.holds, [holdId]: { customer: msg.customer, seats: msg.seats } },
            nextId: state.nextId + 1,
          };
        }
        case 'confirm': {
          const hold = state.holds[msg.holdId];
          if (hold === undefined) {
            msg.replyTo.tell({ ok: false, reason: 'no such hold' });
            return state;
          }
          ctx.timers.cancel(msg.holdId);
          msg.replyTo.tell({ ok: true, seats: hold.seats });
          return {
            ...state,
            sold: state.sold + hold.seats,
            holds: without(state.holds, msg.holdId),
          };
        }
        case 'expire':
          return { ...state, holds: without(state.holds, msg.holdId) };
      }
    },
  });
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

/**
 * Spawns one show per entry of `shows` (name to capacity), and forwards each customer request to
 * its show. The show replies to the customer directly.
 */
export function boxOffice(shows: Readonly<Record<string, number>>) {
  return actor<CustomerRequest, null>({
    initial: (ctx) => {
      for (const [name, capacity] of Object.entries(shows)) {
        ctx.spawn(show(name, capacity), name, {
          supervision: supervise.restartWithBackoff({ minMs: 200, maxMs: 5_000 }),
        });
      }
      // No state: the children are the box office's only data, and ctx.child finds them.
      return null;
    },
    receive: (state, msg, ctx) => {
      // ctx.child gives an AnyRef, because children can speak any protocol. Here, all are shows.
      const target = ctx.child(msg.show) as ActorRef<ShowMsg> | undefined;
      if (target === undefined) msg.replyTo.tell({ ok: false, reason: `no show "${msg.show}"` });
      else target.tell(msg);
      return state;
    },
  });
}
