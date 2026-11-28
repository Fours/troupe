import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { decodeReplay, encodeReplay } from '../../src/rehearsal/replay.js';
import { HUNTS } from '../rehearsal/planted.js';

// Milestone 5, T6: `npm run rehearse`, as people run it, against dist/: seed ranges across worker
// processes with a summary, and each planted bug's shrunk run replayed from its line.

const ROOT = resolve(import.meta.dirname, '../..');
const run = promisify(execFile);

/** Runs scripts/rehearse.ts with `args`, and returns its exit code and what it printed. */
async function rehearse(...args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, ['scripts/rehearse.ts', ...args], {
      cwd: ROOT,
    });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

describe('npm run rehearse', () => {
  it('runs a range of seeds across workers, and prints a summary', async () => {
    const { code, out } = await rehearse(
      '--seeds',
      '1..40',
      '--workers',
      '2',
      '--ignore',
      'recovers,orderPerPair,failoverWithin',
      '--determinism-every',
      '10',
      '--mix',
      'nodes',
    );
    expect(out).toMatch(
      /^40 seeds in contract mode on the nodes mix: [\d,]+ runs in [\d.]+ s on 2 workers, [\d,]+ runs\/s, Node v\d+\.\d+\.\d+$/m,
    );
    expect(out).toMatch(/^ {2}[\d,]+ faults; seeds with violations: /m);
    expect(out).toMatch(/^ {2}ignored: recovers, orderPerPair, failoverWithin$/m);
    expect(out).toMatch(/^ {2}4 seeds run twice, every history identical$/m);
    expect(code).toBe(0);
  }, 120_000);

  it.each(HUNTS)(
    'replays $plant’s shrunk run from its line',
    async ({ plant, invariant, line }) => {
      const { code, out } = await rehearse('--replay', line);
      expect(out).toContain(`${plant} planted`);
      expect(out).toMatch(new RegExp(`^✓ reproduced: ${invariant}: `, 'm'));
      expect(code).toBe(0);
    },
    60_000,
  );

  it('says so, and exits 1, when a line doesn’t reproduce', async () => {
    const [first] = HUNTS;
    if (first === undefined) throw new Error('no hunts recorded');
    const decoded = decodeReplay(first.line);
    const tampered = encodeReplay({
      ...decoded,
      violation: { invariant: 'oneLiveInstance', message: 'show/lear ran twice' },
    });
    const { code, out } = await rehearse('--replay', tampered);
    expect(out).toMatch(
      /^✗ didn't reproduce: the line recorded oneLiveInstance: show\/lear ran twice/m,
    );
    expect(out).toContain("isn't deterministic");
    expect(code).toBe(1);
  }, 60_000);

  it.each([
    [['--seeds', '5'], /--seeds must be a\.\.b/],
    [['--seeds', '9..1'], /--seeds must run upwards/],
    [['--mode', 'wild'], /--mode must be contract or chaos/],
    [['--plant', 'nope'], /--plant must be one of late-deadline, /],
    [['--workers', '0'], /--workers must be a whole number from 1/],
    [['--fast'], /unknown option --fast/],
    [['--replay', 'nope!'], /not a replay line/],
  ])('rejects %j', async (args, message) => {
    const { code, out } = await rehearse(...args);
    expect(out).toMatch(message);
    expect(code).toBe(2);
  });
});
