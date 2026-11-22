// The crowd: customers arriving at the box office, each a short-lived actor that asks for a hold,
// thinks it over, then buys or walks away, and stops.
import { actor, type ActorRef, type Result } from '@kylewillett/troupe';
import type { ConfirmReply, CustomerRequest, HoldReply } from './shows.ts';

/** The most customers in the steady stream at once. A rush goes past it. */
export const MAX_LIVE = 12;

/** How many customers a rush sends at once. */
export const RUSH_SIZE = 30;

/** How long a customer waits for an answer before giving up, in ms. */
export const ASK_TIMEOUT_MS = 3_000;

/**
 * The gap between arrivals in the steady stream, in ms. With {@link SEATS} and
 * {@link BUY_CHANCE}, this sells about one seat a second: lear (40 seats) sells out in about three
 * minutes at 1×, and the whole house in about ten. A sold-out show writes nothing more.
 */
export const ARRIVAL_MS = { min: 400, max: 1_200 } as const;

/** How many seats a customer wants. */
export const SEATS = { min: 1, max: 3 } as const;

/** How long a customer thinks before deciding, in ms. Past HOLD_MS, the hold has expired. */
export const THINK_MS = { min: 500, max: 6_000 } as const;

/** How likely a customer is to buy once they hold seats. */
export const BUY_CHANCE = 0.6;

/** What one customer will do. The crowd draws it, so a customer has no chance of its own. */
export interface Plan {
  readonly show: string;
  readonly seats: number;
  readonly thinkMs: number;
  readonly buys: boolean;
}

/**
 * What a customer hears. `reply` is absent when the ask timed out. (A message event shows a
 * pipe's raw `Result`, not this, since the mapping runs as the message is taken.)
 */
export type CustomerMsg =
  | { type: 'held'; reply?: HoldReply }
  | { type: 'decide'; show: string; buys: boolean }
  | { type: 'bought'; reply?: ConfirmReply };

/** Where a customer is in their visit. */
export type CustomerState =
  | { readonly phase: 'asking' }
  | { readonly phase: 'thinking'; readonly holdId: string }
  | { readonly phase: 'buying'; readonly holdId: string };

const answer = <R>(result: Result<R>): { reply?: R } => (result.ok ? { reply: result.value } : {});

/** One customer, called `name`, who carries out `plan` at `office`. */
export function customer(name: string, plan: Plan, office: ActorRef<CustomerRequest>) {
  const { show, seats } = plan;
  return actor<CustomerMsg, CustomerState>({
    initial: (ctx) => {
      ctx.pipeToSelf(
        office.ask<HoldReply>(
          (replyTo) => ({ type: 'hold', show, customer: name, seats, replyTo }),
          { timeoutMs: ASK_TIMEOUT_MS },
        ),
        (result): CustomerMsg => ({ type: 'held', ...answer(result) }),
      );
      return { phase: 'asking' };
    },
    receive: (state, msg, ctx) => {
      switch (msg.type) {
        case 'held':
          if (msg.reply?.ok !== true) {
            // Turned away, or no answer in time.
            ctx.stop();
            return state;
          }
          ctx.timers.startSingle('decide', { type: 'decide', show, buys: plan.buys }, plan.thinkMs);
          return { phase: 'thinking', holdId: msg.reply.holdId };
        case 'decide': {
          if (state.phase !== 'thinking') return state;
          if (!msg.buys) {
            // Walks away. The hold expires on the show's timer.
            ctx.stop();
            return state;
          }
          const { holdId } = state;
          ctx.pipeToSelf(
            office.ask<ConfirmReply>((replyTo) => ({ type: 'confirm', show, holdId, replyTo }), {
              timeoutMs: ASK_TIMEOUT_MS,
            }),
            (result): CustomerMsg => ({ type: 'bought', ...answer(result) }),
          );
          return { phase: 'buying', holdId };
        }
        case 'bought':
          ctx.stop();
          return state;
      }
    },
  });
}

/** What the crowd handles: its arrival timer, and rushes. */
export type CrowdMsg = { type: 'arrive' } | { type: 'rush'; count: number };

/** The crowd's state: how many customers it has sent, and how many are still at the box office. */
export interface CrowdState {
  readonly sent: number;
  readonly live: number;
}

/** Options for {@link crowd}. */
export interface CrowdOptions {
  /** Where customers go. */
  readonly office: ActorRef<CustomerRequest>;
  /** The shows they choose between. */
  readonly shows: readonly string[];
  /** The crowd's chance: a seeded random, so a seed tells the same story. */
  readonly random: () => number;
  /** Whether customers arrive on their own. Off, only rushes bring them. Default true. */
  readonly arrivals?: boolean;
  /** The gap between arrivals, in ms. Default {@link ARRIVAL_MS}. */
  readonly arrivalMs?: { readonly min: number; readonly max: number };
}

/** A whole number from `min` to `max`, inclusive. */
const between = (random: () => number, min: number, max: number): number =>
  min + Math.floor(random() * (max - min + 1));

/**
 * The crowd: sends a customer every so often, while fewer than {@link MAX_LIVE} are at the box
 * office, and as many as asked at once for a rush. It watches each one, to know when they leave.
 */
export function crowd(opts: CrowdOptions) {
  const { office, shows, random, arrivals = true, arrivalMs = ARRIVAL_MS } = opts;
  const gap = (): number => between(random, arrivalMs.min, arrivalMs.max);

  const plan = (): Plan => ({
    show: shows[between(random, 0, shows.length - 1)] ?? '',
    seats: between(random, SEATS.min, SEATS.max),
    thinkMs: between(random, THINK_MS.min, THINK_MS.max),
    buys: random() < BUY_CHANCE,
  });

  return actor<CrowdMsg, CrowdState>({
    initial: (ctx) => {
      if (arrivals) {
        ctx.timers.startSingle('arrive', { type: 'arrive' }, gap());
      }
      return { sent: 0, live: 0 };
    },
    receive: (state, msg, ctx) => {
      const send = (count: number, from: CrowdState): CrowdState => {
        let next = from;
        for (let i = 0; i < count; i++) {
          const name = `customer-${String(next.sent + 1)}`;
          ctx.watch(ctx.spawn(customer(name, plan(), office), name));
          next = { sent: next.sent + 1, live: next.live + 1 };
        }
        return next;
      };
      switch (msg.type) {
        case 'arrive':
          ctx.timers.startSingle('arrive', { type: 'arrive' }, gap());
          return state.live < MAX_LIVE ? send(1, state) : state;
        case 'rush':
          return send(msg.count, state);
      }
    },
    onSignal: (state, signal) =>
      signal.type === 'terminated' ? { ...state, live: state.live - 1 } : state,
  });
}
