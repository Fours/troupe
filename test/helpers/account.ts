import { persistentActor } from '../../src/persistence/actor.js';
import type { PersistentActorDef } from '../../src/persistence/actor.js';
import type { Persistence } from '../../src/persistence/types.js';
import type { ActorRef } from '../../src/types.js';

export type Receipt = { ok: true; balance: number } | { ok: false; reason: string };

/** A bank account's commands, plus ones that misbehave on purpose. */
export type AccountCmd =
  | { type: 'deposit'; amount: number; replyTo: ActorRef<Receipt> }
  | { type: 'depositTwice'; amount: number; replyTo: ActorRef<Receipt> }
  | { type: 'withdraw'; amount: number; replyTo: ActorRef<Receipt> }
  | { type: 'balance'; replyTo: ActorRef<number> }
  | { type: 'lastSeq'; replyTo: ActorRef<number> }
  | { type: 'noop' }
  | { type: 'close'; replyTo: ActorRef<string> }
  | { type: 'crash' }
  | { type: 'stepThrows'; persist: boolean }
  | { type: 'poison' }
  | { type: 'notJson' }
  | { type: 'notAnEffect' }
  | { type: 'misuse'; how: 'reply' | 'thenReply' | 'thenRun' };

export type AccountEvent =
  | { type: 'deposited'; amount: number }
  | { type: 'withdrawn'; amount: number }
  | { type: 'closed' }
  | { type: 'poisoned' };

export interface Account {
  readonly balance: number;
  readonly closed: boolean;
}

/**
 * A persistent bank account. `log` records its steps and signals, so tests can check their order.
 */
export function account(
  persistence: Persistence,
  opts: {
    id?: string;
    log?: string[];
    snapshots?: PersistentActorDef<AccountCmd, AccountEvent, Account>['snapshots'];
    tags?: PersistentActorDef<AccountCmd, AccountEvent, Account>['tags'];
    timeoutMs?: number;
  } = {},
) {
  const log = opts.log ?? [];
  return persistentActor<AccountCmd, AccountEvent, Account>({
    id: opts.id ?? 'account-1',
    persistence,
    ...(opts.snapshots === undefined ? {} : { snapshots: opts.snapshots }),
    ...(opts.tags === undefined ? {} : { tags: opts.tags }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    initial: { balance: 0, closed: false },
    onCommand(state, cmd, { persist, reply, none, lastSeq }) {
      const receipt = (s: Account): Receipt => ({ ok: true, balance: s.balance });
      switch (cmd.type) {
        case 'deposit':
          return persist({ type: 'deposited', amount: cmd.amount }).thenReply(cmd.replyTo, receipt);
        case 'depositTwice':
          return persist(
            { type: 'deposited', amount: cmd.amount },
            { type: 'deposited', amount: cmd.amount },
          ).thenReply(cmd.replyTo, receipt);
        case 'withdraw':
          if (cmd.amount > state.balance) {
            return reply(cmd.replyTo, { ok: false, reason: 'insufficient funds' });
          }
          return persist({ type: 'withdrawn', amount: cmd.amount }).thenReply(cmd.replyTo, receipt);
        case 'balance':
          return reply(cmd.replyTo, state.balance);
        case 'lastSeq':
          return reply(cmd.replyTo, lastSeq);
        case 'noop':
          return none();
        case 'close':
          return persist({ type: 'closed' })
            .thenRun((s) => log.push(`run 1: closed ${String(s.closed)}`))
            .thenReply(cmd.replyTo, () => 'closed')
            .thenRun(() => log.push('run 2'))
            .thenStop()
            .thenRun(() => log.push('run 3, after thenStop'));
        case 'crash':
          throw new Error('crash requested');
        case 'stepThrows': {
          const effect = cmd.persist ? persist({ type: 'deposited', amount: 1 }) : none();
          return effect.thenRun(() => {
            throw new Error('step failed');
          });
        }
        case 'poison':
          return persist({ type: 'poisoned' });
        case 'notJson':
          return persist({ type: 'deposited', amount: Number.NaN });
        case 'notAnEffect':
          // Tests return something the builders didn't make, on purpose.
          return { events: [] } as unknown as ReturnType<typeof none>;
        case 'misuse': {
          // Tests pass arguments the types forbid, on purpose.
          const bad = undefined as never;
          if (cmd.how === 'reply') return reply(bad, 0);
          if (cmd.how === 'thenReply') return none().thenReply({ tell: () => {} } as never, bad);
          return none().thenRun(bad);
        }
      }
    },
    onEvent(state, event) {
      switch (event.type) {
        case 'deposited':
          return { ...state, balance: state.balance + event.amount };
        case 'withdrawn':
          return { ...state, balance: state.balance - event.amount };
        case 'closed':
          return { ...state, closed: true };
        case 'poisoned':
          throw new Error('poisoned event');
      }
    },
    onSignal(state, signal) {
      log.push(
        signal.type === 'recoveryCompleted'
          ? `recoveryCompleted ${String(signal.seq)}, balance ${String(state.balance)}`
          : `${signal.type}, balance ${String(state.balance)}`,
      );
    },
  });
}
