// Runs the box office on real time and prints the story. `npm run example` builds and runs it.
import { createActorSystem, realScheduler, silentLogger } from '@kylewillett/troupe';
import { narrator } from './narrate.ts';
import { runScenario } from './scenario.ts';

const scheduler = realScheduler();
// The narration already reports every failure from the event stream, so the logger stays quiet.
const system = createActorSystem({ name: 'box-office', scheduler, logger: silentLogger });

await runScenario({
  system,
  narrator: narrator(
    () => scheduler.now(),
    (line) => {
      console.log(line);
    },
  ),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  // Timers keep a Node process alive, and terminate() cancels them, so the process can exit.
  shutdown: () => system.terminate(),
});
