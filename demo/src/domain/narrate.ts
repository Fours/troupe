// The demo's log, in plain words: one line for each event worth telling, from the system's events
// alone, so the log is as deterministic as they are.
import type { Result, SystemEvent } from '@kylewillett/troupe';
import type { CustomerMsg } from './crowd.ts';
import { NO_SUCH_HOLD, type ConfirmReply, type HoldReply, type ReturnReply } from './shows.ts';

const SHOW_PATH = /^\/user\/box-office\/([^/]+)$/;
const CUSTOMER_PATH = /^\/user\/crowd\/([^/]+)$/;
const FEED_PATH = '/user/sales-board/feed';

/**
 * What a `delivered` to a customer carries: its decide timer's message, or a piped ask's raw
 * result, since a pipe's mapping runs only as the message is taken.
 */
type CustomerDelivery =
  Extract<CustomerMsg, { type: 'decide' }> | Result<HoldReply | ConfirmReply | ReturnReply>;

const seats = (n: number): string => `${String(n)} ${n === 1 ? 'seat' : 'seats'}`;

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function customerLine(name: string, msg: CustomerDelivery): string | undefined {
  if ('type' in msg) return msg.buys ? undefined : `${name} walks away, and the hold will expire`;
  if (!msg.ok) return `${name} gave up waiting for an answer`;
  const reply = msg.value;
  if (reply.kind === 'return') {
    return reply.ok
      ? `${name} returns ${seats(reply.seats)} for ${reply.show}, back on sale`
      : `${name} can't return seats for ${reply.show}: ${reply.reason}`;
  }
  if (!reply.ok) {
    if (reply.reason === NO_SUCH_HOLD) {
      return `${name} came back too late: the hold on ${reply.show} had expired`;
    }
    return reply.kind === 'hold'
      ? `${name} is turned away from ${reply.show}: ${reply.reason}`
      : `${name} can't buy for ${reply.show}: ${reply.reason}`;
  }
  return reply.kind === 'hold'
    ? `${name} holds ${seats(reply.seats)} for ${reply.show}`
    : `${name} bought ${seats(reply.seats)} for ${reply.show}`;
}

/** Who an actor is, in the log: a show by its name, the board's feed in words, else its path. */
function who(path: string): string {
  if (path === FEED_PATH) return 'the sales board feed';
  return SHOW_PATH.exec(path)?.[1] ?? path;
}

/** The log line for `event`, or `undefined` if it isn't worth one. */
export function narrate(event: SystemEvent): string | undefined {
  switch (event.type) {
    case 'delivered': {
      const name = CUSTOMER_PATH.exec(event.path)?.[1];
      return name === undefined ? undefined : customerLine(name, event.message as CustomerDelivery);
    }
    case 'failed':
      return `${who(event.path)} failed: ${describeError(event.error)}`;
    case 'restarted':
      return `${who(event.path)} restarts after ${String(event.delayMs)} ms (attempt ${String(event.attempt)})`;
    case 'recovered': {
      const events = event.lastSeq - event.snapshotSeq;
      return events === 0
        ? `${who(event.path)} opens with an empty journal`
        : `${who(event.path)} recovers ${String(events)} ${events === 1 ? 'event' : 'events'} from the journal`;
    }
    default:
      return undefined;
  }
}
