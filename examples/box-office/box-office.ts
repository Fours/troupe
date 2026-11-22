// The box office's actors: one BoxOffice, with one persistent Show child per show.
import { actor, supervise, type ActorRef } from '@kylewillett/troupe';
import { persistentActor, type Persistence } from '@kylewillett/troupe/persistence';

/** How long a hold lasts before its seats go back on sale, in ms. */
export const HOLD_MS = 1000;

/** The answer to a hold. */
export type HoldReply =
  { ok: true; holdId: string; expiresInMs: number } | { ok: false; reason: string };

/** The answer to a confirm. */
export type ConfirmReply = { ok: true; seats: number } | { ok: false; reason: string };

/** The answer to a status request: a show's seats right now. */
export type StatusReply =
  { ok: true; capacity: number; sold: number; held: number } | { ok: false; reason: string };

/** What customers send to the box office. Each request names the show it's for. */
export type CustomerRequest =
  | { type: 'hold'; show: string; customer: string; seats: number; replyTo: ActorRef<HoldReply> }
  | { type: 'confirm'; show: string; holdId: string; replyTo: ActorRef<ConfirmReply> }
  | { type: 'status'; show: string; replyTo: ActorRef<StatusReply> };

/** What a show handles: customer requests, plus its own hold timers. */
export type ShowMsg = CustomerRequest | { type: 'expire'; holdId: string };

/** What a show remembers, in its journal. Every change to its state is one of these. */
export type ShowEvent =
  | { type: 'held'; holdId: string; customer: string; seats: number }
  | { type: 'confirmed'; holdId: string }
  | { type: 'released'; holdId: string };

/** A show's state: plain data, rebuilt from its events. */
export interface ShowState {
  readonly sold: number;
  readonly holds: Readonly<Record<string, { customer: string; seats: number }>>;
  readonly nextId: number;
}

function heldSeats(state: ShowState): number {
  return Object.values(state.holds).reduce((sum, hold) => sum + hold.seats, 0);
}

/**
 * One show, with `capacity` seats, persisted as the stream `show-<name>`. Holds expire after
 * {@link HOLD_MS} unless confirmed.
 */
export function show(name: string, capacity: number, persistence: Persistence) {
  return persistentActor<ShowMsg, ShowEvent, ShowState>({
    id: `show-${name}`,
    persistence,
    initial: { sold: 0, holds: {}, nextId: 1 },
    onCommand: (state, msg, ctx) => {
      const { persist, reply, none } = ctx;
      switch (msg.type) {
        case 'hold': {
          // A malformed request is a bug in the caller. Throwing hands it to supervision.
          if (!Number.isInteger(msg.seats) || msg.seats < 1) {
            throw new RangeError(`seats must be a positive integer, got ${String(msg.seats)}`);
          }
          const free = capacity - state.sold - heldSeats(state);
          if (msg.seats > free) {
            return reply(msg.replyTo, {
              ok: false,
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
              .thenReply(msg.replyTo, (): HoldReply => ({ ok: true, holdId, expiresInMs: HOLD_MS }))
          );
        }
        case 'confirm': {
          const hold = state.holds[msg.holdId];
          if (hold === undefined) return reply(msg.replyTo, { ok: false, reason: 'no such hold' });
          return persist({ type: 'confirmed', holdId: msg.holdId })
            .thenRun(() => {
              ctx.timers.cancel(msg.holdId);
            })
            .thenReply(msg.replyTo, (): ConfirmReply => ({ ok: true, seats: hold.seats }));
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
    // Pure, because it runs again for every event on every recovery.
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
        case 'confirmed': {
          const hold = state.holds[event.holdId];
          return {
            ...state,
            sold: state.sold + (hold?.seats ?? 0),
            holds: without(state.holds, event.holdId),
          };
        }
        case 'released':
          return { ...state, holds: without(state.holds, event.holdId) };
      }
    },
    onSignal: (state, signal, ctx) => {
      // Timers don't survive a restart, and a hold doesn't record how long it had left, so each
      // recovered hold gets a fresh one. Durable timers are a later idea.
      if (signal.type !== 'recoveryCompleted') return;
      for (const holdId of Object.keys(state.holds)) {
        ctx.timers.startSingle(holdId, { type: 'expire', holdId }, HOLD_MS);
      }
    },
  });
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

/**
 * Spawns one show per entry of `shows` (name to capacity), each persisted in `persistence`, and
 * forwards each customer request to its show. The show replies to the customer directly.
 */
export function boxOffice(shows: Readonly<Record<string, number>>, persistence: Persistence) {
  return actor<CustomerRequest, null>({
    initial: (ctx) => {
      for (const [name, capacity] of Object.entries(shows)) {
        // Backoff suits a persistent show: each restart replays the journal, so a show that keeps
        // failing shouldn't hammer it.
        ctx.spawn(show(name, capacity, persistence), name, {
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
