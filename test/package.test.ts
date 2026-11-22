import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { exportsOf, program, root } from './helpers/exports.js';

// The public API, as the milestone 1 spec lists it under T6.
const MAIN_VALUES = [
  'ActorNameError',
  'ActorStoppedError',
  'ActorSystemTerminatedError',
  'AskTimeoutError',
  'NotAChildError',
  'actor',
  'consoleLogger',
  'createActorSystem',
  'realScheduler',
  'silentLogger',
  'supervise',
];
const MAIN_TYPES = [
  'ActorContext',
  'ActorDef',
  'ActorRef',
  'ActorSystem',
  'ActorSystemOptions',
  'AnyRef',
  'AskOptions',
  'EventStream',
  'LogLevel',
  'Logger',
  'Result',
  'Scheduler',
  'Signal',
  'SpawnOptions',
  'SupervisorStrategy',
  'SystemEvent',
  'Timers',
];
const TESTKIT_VALUES = [
  'ManualScheduler',
  'SettleTimeoutError',
  'TestProbe',
  'createTestKit',
  'seededRandom',
];
const TESTKIT_TYPES = ['LogEntry', 'ManualSchedulerOptions', 'TestKit', 'TestKitOptions'];
// The milestone 2 spec's T1 and T2 names, plus NewSnapshot: the backend stamps a snapshot's
// timestamp.
const PERSISTENCE_VALUES = [
  'EventValidationError',
  'EventVersionError',
  'JournalConflictError',
  'JournalSequenceError',
  'inMemoryPersistence',
  'persistentActor',
  'projection',
];
const PERSISTENCE_TYPES = [
  'Effect',
  'EventOptions',
  'InMemoryPersistence',
  'Journal',
  'NewEvent',
  'NewSnapshot',
  'OffsetStore',
  'Persistence',
  'PersistentActorDef',
  'PersistentContext',
  'PersistentSignal',
  'PersistentState',
  'ProjectionOptions',
  'ProjectionState',
  'Snapshot',
  'SnapshotStore',
  'StandardSchemaV1',
  'StoredEvent',
];
// The milestone 2 spec's T6 names.
const SQLITE_VALUES = ['sqlitePersistence'];
const SQLITE_TYPES = ['SqlitePersistence'];
// The milestone 2 spec's T7 names, plus the pool's client and the query method they share, so
// a wrapper around a pool can be typed.
const POSTGRES_VALUES = ['postgresPersistence'];
const POSTGRES_TYPES = ['PgPool', 'PgPoolClient', 'PgQueryable', 'PostgresPersistence'];
// The milestone 3 spec's protocol, plus the types its frames and responses are made of.
const BACKSTAGE_VALUES = ['backstage', 'encode'];
const BACKSTAGE_TYPES = [
  'ActorInfo',
  'ActorStatus',
  'BackstageError',
  'BackstageOptions',
  'BackstageRequest',
  'BackstageResponse',
  'BackstageSource',
  'Frame',
  'TimelineEvent',
  'WireEvent',
  'WireValue',
];
// The milestone 3 spec's server.
const SERVER_VALUES = ['serveBackstage'];
const SERVER_TYPES = ['BackstageServer', 'BackstageServerOptions'];
const ENTRY_POINTS = [
  '@kylewillett/troupe',
  '@kylewillett/troupe/testkit',
  '@kylewillett/troupe/persistence',
  '@kylewillett/troupe/persistence/sqlite',
  '@kylewillett/troupe/persistence/postgres',
];

/**
 * Every module URL Node resolves while it imports `specifier` from the package, in a separate
 * process, so a lazy or conditional import counts only if it actually runs.
 */
function loadedBy(specifier: string): string[] {
  const script = `
    import { registerHooks } from 'node:module';
    const seen = [];
    registerHooks({
      resolve(spec, context, next) {
        const result = next(spec, context);
        seen.push(result.url);
        return result;
      },
    });
    await import(${JSON.stringify(specifier)});
    console.log(JSON.stringify(seen));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
  });
  return JSON.parse(out) as string[];
}

const sorted = (names: Iterable<string>) => [...names].sort((a, b) => a.localeCompare(b));

describe('the built package', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
  }, 60_000);

  it('loads every entry point by name, with exactly the spec’s runtime exports', () => {
    // A separate Node process resolves the package through its own exports map, as a user would.
    const script = `
      const main = await import('@kylewillett/troupe');
      const testkit = await import('@kylewillett/troupe/testkit');
      const persistence = await import('@kylewillett/troupe/persistence');
      const sqlite = await import('@kylewillett/troupe/persistence/sqlite');
      const postgres = await import('@kylewillett/troupe/persistence/postgres');
      const backstage = await import('@kylewillett/troupe/backstage');
      const server = await import('@kylewillett/troupe/backstage/server');
      console.log(JSON.stringify({
        main: Object.keys(main),
        testkit: Object.keys(testkit),
        persistence: Object.keys(persistence),
        sqlite: Object.keys(sqlite),
        postgres: Object.keys(postgres),
        backstage: Object.keys(backstage),
        server: Object.keys(server),
      }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
    });
    const loaded = JSON.parse(out) as Record<
      'main' | 'testkit' | 'persistence' | 'sqlite' | 'postgres' | 'backstage' | 'server',
      string[]
    >;
    expect(sorted(loaded.main)).toEqual(sorted(MAIN_VALUES));
    expect(sorted(loaded.testkit)).toEqual(sorted(TESTKIT_VALUES));
    expect(sorted(loaded.persistence)).toEqual(sorted(PERSISTENCE_VALUES));
    expect(sorted(loaded.sqlite)).toEqual(sorted(SQLITE_VALUES));
    expect(sorted(loaded.postgres)).toEqual(sorted(POSTGRES_VALUES));
    expect(sorted(loaded.backstage)).toEqual(sorted(BACKSTAGE_VALUES));
    expect(sorted(loaded.server)).toEqual(sorted(SERVER_VALUES));
  });

  it('declares exactly the spec’s names, types included', () => {
    const main = `${root}dist/index.d.ts`;
    const testkit = `${root}dist/testkit/index.d.ts`;
    const persistence = `${root}dist/persistence/index.d.ts`;
    const sqlite = `${root}dist/node/sqlite/index.d.ts`;
    const postgres = `${root}dist/persistence/postgres/index.d.ts`;
    const backstage = `${root}dist/backstage/index.d.ts`;
    const server = `${root}dist/node/backstage/index.d.ts`;
    const prog = program([main, testkit, persistence, sqlite, postgres, backstage, server]);
    expect(sorted(exportsOf(prog, main).keys())).toEqual(sorted([...MAIN_VALUES, ...MAIN_TYPES]));
    expect(sorted(exportsOf(prog, testkit).keys())).toEqual(
      sorted([...TESTKIT_VALUES, ...TESTKIT_TYPES]),
    );
    expect(sorted(exportsOf(prog, persistence).keys())).toEqual(
      sorted([...PERSISTENCE_VALUES, ...PERSISTENCE_TYPES]),
    );
    expect(sorted(exportsOf(prog, sqlite).keys())).toEqual(
      sorted([...SQLITE_VALUES, ...SQLITE_TYPES]),
    );
    expect(sorted(exportsOf(prog, postgres).keys())).toEqual(
      sorted([...POSTGRES_VALUES, ...POSTGRES_TYPES]),
    );
    expect(sorted(exportsOf(prog, backstage).keys())).toEqual(
      sorted([...BACKSTAGE_VALUES, ...BACKSTAGE_TYPES]),
    );
    expect(sorted(exportsOf(prog, server).keys())).toEqual(
      sorted([...SERVER_VALUES, ...SERVER_TYPES]),
    );
  });

  it('loads nothing from /persistence when the core is imported', () => {
    const core = loadedBy('@kylewillett/troupe');
    // The check only means something if the hook saw the core's own modules.
    expect(core).toContain(`file://${root}dist/system.js`);
    expect(core.filter((url) => url.includes('/dist/persistence/'))).toEqual([]);
  });

  it('loads /persistence from dist/, on top of the core’s internal modules', () => {
    const loaded = loadedBy('@kylewillett/troupe/persistence');
    expect(loaded).toContain(`file://${root}dist/persistence/index.js`);
    expect(loaded.every((url) => url.startsWith(`file://${root}dist/`))).toBe(true);
  });

  it('loads /persistence/sqlite from dist/ and node:sqlite', () => {
    const loaded = loadedBy('@kylewillett/troupe/persistence/sqlite');
    expect(loaded).toContain(`file://${root}dist/node/sqlite/index.js`);
    // The check below means something only if the hook sees node:sqlite when it does load.
    expect(loaded).toContain('node:sqlite');
    expect(loaded.filter((url) => !url.startsWith(`file://${root}dist/`))).toEqual(['node:sqlite']);
  });

  it('loads node:sqlite from neither the core nor /persistence', () => {
    for (const specifier of ['@kylewillett/troupe', '@kylewillett/troupe/persistence']) {
      const loaded = loadedBy(specifier);
      expect(loaded.filter((url) => url.startsWith('node:'))).toEqual([]);
      expect(loaded.filter((url) => url.includes('/dist/node/'))).toEqual([]);
    }
  });

  it('loads /persistence/postgres from dist/ alone, never pg or a Node built-in', () => {
    const loaded = loadedBy('@kylewillett/troupe/persistence/postgres');
    expect(loaded).toContain(`file://${root}dist/persistence/postgres/index.js`);
    expect(loaded.filter((url) => !url.startsWith(`file://${root}dist/`))).toEqual([]);
    // The check above means something only if the hook sees pg when it does load.
    expect(loadedBy('pg').some((url) => url.includes('/node_modules/pg/'))).toBe(true);
  });

  it('loads pg from neither the core nor /persistence', () => {
    for (const specifier of ['@kylewillett/troupe', '@kylewillett/troupe/persistence']) {
      const loaded = loadedBy(specifier);
      expect(loaded.filter((url) => url.includes('/node_modules/'))).toEqual([]);
      expect(loaded.filter((url) => url.includes('/dist/persistence/postgres/'))).toEqual([]);
    }
  });

  it('loads /backstage from dist/ alone, never a Node built-in', () => {
    const loaded = loadedBy('@kylewillett/troupe/backstage');
    expect(loaded).toContain(`file://${root}dist/backstage/index.js`);
    expect(loaded.filter((url) => !url.startsWith(`file://${root}dist/`))).toEqual([]);
    expect(loaded.filter((url) => url.includes('/dist/node/'))).toEqual([]);
  });

  it('loads /backstage from no other entry point', () => {
    for (const specifier of ENTRY_POINTS) {
      const loaded = loadedBy(specifier);
      // The check only means something if the hook saw the entry point's own modules.
      expect(loaded.length, specifier).toBeGreaterThan(1);
      expect(
        loaded.filter((url) => url.includes('/dist/backstage/')),
        specifier,
      ).toEqual([]);
    }
  });

  it('loads /backstage/server from dist/ and Node built-ins alone', () => {
    const loaded = loadedBy('@kylewillett/troupe/backstage/server');
    expect(loaded).toContain(`file://${root}dist/node/backstage/index.js`);
    // The check below means something only if the hook sees node:http when it does load.
    expect(loaded).toContain('node:http');
    expect(
      loaded.filter((url) => !url.startsWith(`file://${root}dist/`) && !url.startsWith('node:')),
    ).toEqual([]);
  });

  it('loads node:http and /backstage/server from no other entry point', () => {
    for (const specifier of [...ENTRY_POINTS, '@kylewillett/troupe/backstage']) {
      const loaded = loadedBy(specifier);
      expect(loaded, specifier).not.toContain('node:http');
      expect(
        loaded.filter((url) => url.includes('/dist/node/backstage/')),
        specifier,
      ).toEqual([]);
    }
  });

  it('packs the built UI, and serves it from dist/', async () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
    });
    const [pack] = JSON.parse(out) as { files: { path: string }[] }[];
    const files = (pack?.files ?? []).map((f) => f.path);
    expect(files).toContain('dist/backstage-ui/index.html');
    const assets = files.filter((f) => f.startsWith('dist/backstage-ui/assets/'));
    expect(assets.some((f) => f.endsWith('.js'))).toBe(true);
    expect(assets.some((f) => f.endsWith('.css'))).toBe(true);

    // The built server finds the built UI beside it, and the page's script is there too.
    const { serveBackstage } = (await import(
      `${root}dist/node/backstage/index.js`
    )) as typeof import('@kylewillett/troupe/backstage/server');
    const { createActorSystem, silentLogger } = (await import(
      `${root}dist/index.js`
    )) as typeof import('@kylewillett/troupe');
    const system = createActorSystem({ name: 'packed', logger: silentLogger });
    const server = await serveBackstage(system, { port: 0 });
    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('<title>Backstage · Troupe</title>');
      const script = /src="\.\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
      expect(script).toBeDefined();
      expect(files).toContain(`dist/backstage-ui/${String(script)}`);
      const js = await fetch(new URL(String(script), server.url));
      expect(js.status).toBe(200);
      expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    } finally {
      await server.close();
      await system.terminate();
    }
  });

  it('ships the Postgres table SQL for the default schema', async () => {
    const sql = readFileSync(`${root}dist/persistence/postgres/schema.sql`, 'utf8');
    const { postgresSchemaSql } = await import('../src/persistence/postgres/schema.js');
    expect(sql).toBe(postgresSchemaSql('troupe'));
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "troupe".events');
  });

  it('ships the SQLite table SQL, which makes a database the backend can use', async () => {
    const sql = readFileSync(`${root}dist/node/sqlite/schema.sql`, 'utf8');
    const dir = mkdtempSync(join(tmpdir(), 'troupe-schema-'));
    try {
      const path = join(dir, 'migrated.db');
      // As someone who manages migrations would: run the file, then open the backend on it.
      const raw = new DatabaseSync(path);
      raw.exec(sql);
      raw.close();
      const { sqlitePersistence } = (await import(
        `${root}dist/node/sqlite/index.js`
      )) as typeof import('@kylewillett/troupe/persistence/sqlite');
      const p = sqlitePersistence({ path, clock: () => 1 });
      await p.journal.append('a', 0, [{ event: 'x', version: 1, tags: ['t'] }]);
      expect((await p.journal.readByTag('t', 0, 1)).map((e) => e.event)).toEqual(['x']);
      p.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
