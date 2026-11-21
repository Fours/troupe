// On the real scheduler, because the point is that the host's event loop gets a turn
// (decision 0007). AGENTS.md allows real time here only.
import { expect, it } from 'vitest';
import { actor } from '../src/actor.js';
import { silentLogger } from '../src/logger.js';
import { createActorSystem } from '../src/system.js';
import type { ActorRef } from '../src/types.js';

it('lets a real setTimeout(0) fire while two actors ping-pong without end', async () => {
  const system = createActorSystem({ logger: silentLogger });
  let rallies = 0;
  let playing = true;
  type Ball = { from: ActorRef<Ball> };
  const player = actor<Ball, null>({
    initial: null,
    receive: (s, ball, ctx) => {
      rallies++;
      // Stop once the test is over, so the rally can't leak into other tests.
      if (playing) ball.from.tell({ from: ctx.self });
      return s;
    },
  });
  const ping = system.spawn(player);
  const pong = system.spawn(player);
  ping.tell({ from: pong });

  const atTimer = await new Promise<number>((resolve) =>
    setTimeout(() => {
      resolve(rallies);
    }, 0),
  );
  playing = false;

  // The rally had started, and the timer fired while it was still going.
  expect(atTimer).toBeGreaterThan(0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const settled = rallies;
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(rallies).toBe(settled);
});
