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

const sorted = (names: Iterable<string>) => [...names].sort((a, b) => a.localeCompare(b));

describe('the built package', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
  }, 60_000);

  it('loads both entry points by name, with exactly the spec’s runtime exports', () => {
    // A separate Node process resolves the package through its own exports map, as a user would.
    const script = `
      const main = await import('@kylewillett/troupe');
      const testkit = await import('@kylewillett/troupe/testkit');
      console.log(JSON.stringify({ main: Object.keys(main), testkit: Object.keys(testkit) }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
    });
    const loaded = JSON.parse(out) as { main: string[]; testkit: string[] };
    expect(sorted(loaded.main)).toEqual(sorted(MAIN_VALUES));
    expect(sorted(loaded.testkit)).toEqual(sorted(TESTKIT_VALUES));
  });

  it('declares exactly the spec’s names, types included', () => {
    const main = `${root}dist/index.d.ts`;
    const testkit = `${root}dist/testkit/index.d.ts`;
    const prog = program([main, testkit]);
    expect(sorted(exportsOf(prog, main).keys())).toEqual(sorted([...MAIN_VALUES, ...MAIN_TYPES]));
    expect(sorted(exportsOf(prog, testkit).keys())).toEqual(
      sorted([...TESTKIT_VALUES, ...TESTKIT_TYPES]),
    );
  });
});
