// The sales board: seats sold per show, read from the journal by a projection on the sale tag.
import { actor, supervise, type ActorRef } from '@kylewillett/troupe';
import { projection, type Persistence } from '@kylewillett/troupe/persistence';
import { SALE_TAG, SHOW_BACKOFF } from './shows.ts';

/**
 * What the board handles: a sale from its feed, or a request for the totals. A return is a sale
 * of minus its seats.
 */
export type BoardMsg =
  | { type: 'sale'; offset: number; show: string; seats: number }
  | { type: 'totals'; replyTo: ActorRef<Readonly<Record<string, number>>> };

/** The board's state: seats sold per show, and the offset of the last sale counted. */
export interface BoardState {
  readonly sold: Readonly<Record<string, number>>;
  readonly offset: number;
}

const SHOW_PREFIX = 'show-';

/**
 * The sales board. Its child `feed` is a projection on the `sale` tag that tells the board each
 * sale. A projection delivers at least once, so the board skips any offset it has already
 * counted.
 *
 * `persistence.offsets` should be the system's own, not the journal's backend: then a new system
 * reads every sale again, and the board, which keeps its totals only in memory, starts complete.
 */
export function salesBoard(persistence: Persistence) {
  return actor<BoardMsg, BoardState>({
    initial: (ctx) => {
      const { self } = ctx;
      ctx.spawn(
        projection({
          name: 'sales-board',
          persistence,
          tag: SALE_TAG,
          pollMs: 250,
          handle: (stored) => {
            const event = stored.event as { type?: unknown; seats?: unknown };
            if (typeof event.seats !== 'number' || !stored.persistenceId.startsWith(SHOW_PREFIX)) {
              return;
            }
            self.tell({
              type: 'sale',
              offset: stored.offset,
              show: stored.persistenceId.slice(SHOW_PREFIX.length),
              seats: event.type === 'returned' ? -event.seats : event.seats,
            });
          },
        }),
        'feed',
        // It fails while the journal is down, and comes back as the shows do.
        { supervision: supervise.restartWithBackoff(SHOW_BACKOFF) },
      );
      return { sold: {}, offset: 0 };
    },
    receive: (state, msg) => {
      switch (msg.type) {
        case 'sale':
          if (msg.offset <= state.offset) return state;
          return {
            sold: { ...state.sold, [msg.show]: (state.sold[msg.show] ?? 0) + msg.seats },
            offset: msg.offset,
          };
        case 'totals':
          msg.replyTo.tell(state.sold);
          return state;
      }
    },
  });
}
