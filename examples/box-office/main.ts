// Runs the box office on real time and SQLite, and prints the story. `npm run example` builds and
// runs it.
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createActorSystem, realScheduler, silentLogger } from '@kylewillett/troupe';
import { sqlitePersistence } from '@kylewillett/troupe/persistence/sqlite';
import { narrator } from './narrate.ts';
import { runScenario } from './scenario.ts';

// Resolved from this file, so the example finds the same database from any directory.
const dir = fileURLToPath(new URL('../../.troupe/', import.meta.url));
const path = `${dir}box-office.db`;
// A fresh database every run, so the story repeats. WAL mode keeps two files beside it.
for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
mkdirSync(dir, { recursive: true });

await runScenario({
  open: () => {
    const scheduler = realScheduler();
    const persistence = sqlitePersistence({ path });
    // The narration already reports every failure from the event stream, so the logger stays quiet.
    const system = createActorSystem({ name: 'box-office', scheduler, logger: silentLogger });
    return {
      system,
      persistence,
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
      shutdown: async () => {
        await system.terminate();
        persistence.close();
      },
    };
  },
});
