// A show at festival night, as a sharded entity: a persistent actor that sells seats. Every event
// says which incarnation of the show wrote it, so a run can check from the journal alone that no
// two incarnations of one show were ever live at once (milestone 4, "The invariant").
import type { ActorRef } from '@kylewillett/troupe';
import { persistentActor, type Persistence } from '@kylewillett/troupe/persistence';

/** The shows the crowd buys seats at. Entity ids, so actor names. */
export const SHOWS = [
  'hamlet',
  'macbeth',
  'othello',
  'king-lear',
  'the-tempest',
  'twelfth-night',
  'as-you-like-it',
  'much-ado',
  'the-seagull',
  'uncle-vanya',
  'three-sisters',
  'the-cherry-orchard',
] as const;

/** Seats per show: more than any run sells, so every buy can be acknowledged. */
export const CAPACITY = 1_000_000;

/**
 * The answer to a buy. `inc` is the incarnation that answered, `<node>#<uid>:<n>`, so whoever
 * asked can see which node the show is on now.
 */
export type BuyReply =
  | { readonly ok: true; readonly saleId: string; readonly inc: string }
  | { readonly ok: false; readonly reason: string; readonly inc: string };

/** What a show is sent. */
export type ShowCmd = {
  readonly type: 'buy';
  readonly customer: string;
  readonly seats: number;
  readonly replyTo: ActorRef<BuyReply>;
};

/** What a show's journal holds: one event per sale, stamped with the incarnation that made it. */
export type ShowEvent = {
  readonly type: 'sold';
  readonly saleId: string;
  readonly customer: string;
  readonly seats: number;
  readonly inc: string;
};

/** A show's state, rebuilt from its sales. */
export interface ShowState {
  readonly sold: number;
  readonly sales: number;
}

/** The journal stream of the show with this id. */
export function streamId(show: string): string {
  return `show-${show}`;
}

/**
 * The `entity` for `sharding.init`. Sharding calls it once per incarnation, on an entity's first
 * message and after each stop, so each call takes the node's next incarnation number. The number
 * lives here, not in the state, which stays plain data rebuilt from the journal.
 * @param node This node's holder name, `<address>#<uid>`, new on every start.
 */
export function showEntity(persistence: Persistence, node: string) {
  let incarnations = 0;
  return (id: string) => {
    incarnations++;
    return show(id, persistence, `${node}:${String(incarnations)}`);
  };
}

function show(id: string, persistence: Persistence, inc: string) {
  return persistentActor<ShowCmd, ShowEvent, ShowState>({
    id: streamId(id),
    persistence,
    initial: { sold: 0, sales: 0 },
    onCommand: (state, cmd, { persist, reply }) => {
      // A message from another process is input: answer a bad one rather than fail on it.
      if (!Number.isSafeInteger(cmd.seats) || cmd.seats < 1) {
        return reply(cmd.replyTo, { ok: false, reason: 'seats must be a positive integer', inc });
      }
      if (state.sold + cmd.seats > CAPACITY) {
        return reply(cmd.replyTo, { ok: false, reason: 'sold out', inc });
      }
      const saleId = `${id}-${String(state.sales + 1)}`;
      return (
        persist({ type: 'sold', saleId, customer: cmd.customer, seats: cmd.seats, inc })
          // Only once the sale is in the journal: an acknowledged sale is never lost.
          .thenReply(cmd.replyTo, (): BuyReply => ({ ok: true, saleId, inc }))
      );
    },
    onEvent: (state, event) => ({ sold: state.sold + event.seats, sales: state.sales + 1 }),
  });
}
