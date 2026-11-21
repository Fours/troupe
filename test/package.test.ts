import { execFileSync } from 'node:child_process';
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
  'JournalConflictError',
  'JournalSequenceError',
  'inMemoryPersistence',
  'persistentActor',
];
const PERSISTENCE_TYPES = [
  'Effect',
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
  'Snapshot',
  'SnapshotStore',
  'StoredEvent',
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
      console.log(JSON.stringify({
        main: Object.keys(main),
        testkit: Object.keys(testkit),
        persistence: Object.keys(persistence),
      }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
    });
    const loaded = JSON.parse(out) as { main: string[]; testkit: string[]; persistence: string[] };
    expect(sorted(loaded.main)).toEqual(sorted(MAIN_VALUES));
    expect(sorted(loaded.testkit)).toEqual(sorted(TESTKIT_VALUES));
    expect(sorted(loaded.persistence)).toEqual(sorted(PERSISTENCE_VALUES));
  });

  it('declares exactly the spec’s names, types included', () => {
    const main = `${root}dist/index.d.ts`;
    const testkit = `${root}dist/testkit/index.d.ts`;
    const persistence = `${root}dist/persistence/index.d.ts`;
    const prog = program([main, testkit, persistence]);
    expect(sorted(exportsOf(prog, main).keys())).toEqual(sorted([...MAIN_VALUES, ...MAIN_TYPES]));
    expect(sorted(exportsOf(prog, testkit).keys())).toEqual(
      sorted([...TESTKIT_VALUES, ...TESTKIT_TYPES]),
    );
    expect(sorted(exportsOf(prog, persistence).keys())).toEqual(
      sorted([...PERSISTENCE_VALUES, ...PERSISTENCE_TYPES]),
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
});
