import { describe, expect, it } from 'vitest';
import { actor } from '../src/actor.js';
import { supervise } from '../src/supervision.js';
import { createTestKit } from '../src/testkit/kit.js';
import type { ActorRef, Result, SystemEvent } from '../src/types.js';

type WorkerMsg = { type: 'tick' } | { type: 'crash' } | { type: 'get'; replyTo: ActorRef<number> };

type ClientMsg = { type: 'poll' } | { type: 'answer'; result: Result<number> };

/** Counts its periodic ticks, crashes on request, and answers asks for the count. */
const worker = actor<WorkerMsg, number>({
  initial: (ctx) => {
    ctx.timers.startPeriodic('tick', { type: 'tick' }, 50);
    return 0;
  },
  receive: (count, msg) => {
    switch (msg.type) {
      case 'tick':
        return count + 1;
      case 'crash':
        throw new Error('crash requested');
      case 'get':
        msg.replyTo.tell(count);
        return count;
    }
  },
});

/** Asks the worker for its count without blocking, and reports what came back. */
function client(target: ActorRef<WorkerMsg>, out: ActorRef<string>) {
  return actor<ClientMsg, null>({
    initial: null,
    receive: (s, msg, ctx) => {
      if (msg.type === 'poll') {
        const answer = target.ask<number>((replyTo) => ({ type: 'get', replyTo }), {
          timeoutMs: 30,
        });
        ctx.pipeToSelf(answer, (result) => ({ type: 'answer', result }));
      } else {
        out.tell(
          msg.result.ok
            ? `count ${String(msg.result.value)}`
            : `failed ${String(msg.result.error)}`,
        );
      }
      return s;
    },
  });
}

/**
 * Periodic timers, two asks (one times out while the worker waits out its backoff, so its late
 * reply is a dead letter), two crashes under backoff with jitter, and a stop.
 */
async function scenario(seed: number) {
  const kit = createTestKit({ seed });
  const out = kit.probe<string>('out');
  const w = kit.system.spawn(worker, 'worker', {
    supervision: supervise.restartWithBackoff({ minMs: 100, maxMs: 1000, randomFactor: 0.5 }),
  });
  const c = kit.system.spawn(client(w, out.ref), 'client');
  await kit.advance(120);
  w.tell({ type: 'crash' });
  await kit.advance(10);
  c.tell({ type: 'poll' });
  await kit.advance(2000);
  w.tell({ type: 'crash' });
  await kit.advance(2000);
  c.tell({ type: 'poll' });
  await kit.advance(100);
  kit.system.stop(w);
  await kit.advance(100);
  await kit.shutdown();
  return { events: snapshot(kit.events), replies: out.messages() };
}

/** Events as plain data, so two runs compare by content: errors by name and message. */
function snapshot(events: readonly SystemEvent[]): unknown {
  return JSON.parse(
    JSON.stringify(events, (_key, value: unknown) =>
      value instanceof Error ? `${value.name}: ${value.message}` : value,
    ),
  );
}

function restartDelays(events: unknown): number[] {
  return (events as SystemEvent[]).flatMap((e) => (e.type === 'restarted' ? [e.delayMs] : []));
}

describe('determinism', () => {
  it('replays a scenario with the same seed to identical events', async () => {
    const first = await scenario(1);
    const second = await scenario(1);
    expect(second).toEqual(first);

    // The scenario really did exercise everything it claims to.
    const types = new Set((first.events as SystemEvent[]).map((e) => e.type));
    expect([...types].sort()).toEqual(['deadLetter', 'failed', 'restarted', 'spawned', 'stopped']);
    expect(restartDelays(first.events)).toHaveLength(2);
    expect(first.replies).toHaveLength(2);
    expect(first.replies[0]).toMatch(/^failed AskTimeoutError/);
    expect(first.replies[1]).toMatch(/^count \d+$/);
  });

  it('changes the backoff delays with a different seed', async () => {
    const one = await scenario(1);
    const two = await scenario(2);
    expect(restartDelays(two.events)).not.toEqual(restartDelays(one.events));
  });
});
