// The crowd: a node that hosts nothing and only routes, with CUSTOMERS_PER_SHOW customers at each
// show buying seats over and over, so each show has more than one buy in flight at a time. Every
// answer is a line: `ack` with the sale and the incarnation that made it, `refused`, or `timeout`
// when no answer came within ASK_TIMEOUT_MS. An acknowledged sale is in the journal, which is
// what the multi-process test checks.
//
//   CLUSTER_SECRET=s NODE_PORT=2560 SEEDS=127.0.0.1:2552,127.0.0.1:2553 node examples/cluster/crowd.ts
import { crowdEnv } from './env.ts';
import { describeError, emit } from './log.ts';
import type { BuyReply } from './show.ts';
import { startNode, stopOnSignals } from './start.ts';

const env = crowdEnv(process.env);
const node = await startNode(env, { host: false });

let running = true;
const queue = env.shows.flatMap((show) =>
  Array.from({ length: env.customersPerShow }, (_, k) => ({ show, k })),
);
const customers = queue.map(async ({ show, k }, i) => {
  const ref = node.shows.ref(show);
  const customer = `${show}-customer-${String(k + 1)}`;
  while (running) {
    const started = performance.now();
    try {
      const reply = await ref.ask<BuyReply>(
        (replyTo) => ({ type: 'buy', customer, seats: 1 + (i % 4), replyTo }),
        { timeoutMs: env.askTimeoutMs },
      );
      const ms = Math.round(performance.now() - started);
      if (reply.ok) emit({ ev: 'ack', show, saleId: reply.saleId, inc: reply.inc, ms });
      else emit({ ev: 'refused', show, reason: reply.reason, inc: reply.inc, ms });
    } catch (error) {
      const { name, message } = describeError(error);
      // A timeout is the one failure an ask has here: the answer, or the buy, was lost.
      // It has already waited, so it asks again at once.
      if (name === 'AskTimeoutError') {
        emit({ ev: 'timeout', show });
        continue;
      }
      emit({ ev: 'error', show, error: name, message });
    }
    if (env.pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, env.pauseMs));
  }
});

stopOnSignals(async () => {
  running = false;
  await Promise.all(customers);
  await node.stop();
});
