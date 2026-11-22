// Opening night in Node, on real time and SQLite, with Backstage served on localhost: the same
// UI as the demo page, over HTTP instead of in-process. `npm run example:backstage` builds and
// runs it, and prints the URL to open. `--port 0` picks a free port.
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createActorSystem, realScheduler, silentLogger } from '@kylewillett/troupe';
import { sqlitePersistence } from '@kylewillett/troupe/persistence/sqlite';
import { serveBackstage } from '@kylewillett/troupe/backstage/server';
import { crowd } from '../../demo/src/domain/crowd.ts';
import { salesBoard } from '../../demo/src/domain/sales-board.ts';
import { boxOffice, SHOWS } from '../../demo/src/domain/shows.ts';

/** When the one bad request goes to hamlet, so the failure history has something in it. */
const BAD_REQUEST_AFTER_MS = 10_000;

const { values } = parseArgs({ options: { port: { type: 'string', default: '7070' } } });
const port = Number(values.port);

// A fresh database every run, beside the box office example's. WAL mode keeps two files beside it.
const dir = fileURLToPath(new URL('../../.troupe/', import.meta.url));
const path = `${dir}opening-night.db`;
for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
mkdirSync(dir, { recursive: true });

const persistence = sqlitePersistence({ path });
// Backstage shows every failure, so the logger stays quiet.
const system = createActorSystem({
  name: 'opening-night',
  scheduler: realScheduler(),
  logger: silentLogger,
});
// Attached before anything spawns, so its history has every spawn.
const server = await serveBackstage(system, { port });

const office = system.spawn(boxOffice(SHOWS, persistence), 'box-office');
system.spawn(salesBoard(persistence), 'sales-board');
system.spawn(crowd({ office, shows: Object.keys(SHOWS), random: Math.random }), 'crowd');

const badRequest = setTimeout(() => {
  office
    .ask((replyTo) => ({ type: 'hold', show: 'hamlet', customer: 'mallory', seats: -1, replyTo }), {
      timeoutMs: 1_000,
    })
    .catch(() => undefined);
}, BAD_REQUEST_AFTER_MS);

console.log(`Backstage for opening night: ${server.url}`);
console.log('Press Ctrl+C to stop.');

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearTimeout(badRequest);
  await server.close();
  await system.terminate();
  persistence.close();
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stop();
  });
}
