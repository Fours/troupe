import { describe, expect, it } from 'vitest';
import { festivalOptions } from '../../demo/src/rehearsal/domain/festival.js';
import type { Plant } from '../../src/internal.js';
import { huntOptions, isPlant, planted, PLANTED } from '../../src/rehearsal/plants.js';
import { rehearseWith, replay } from '../../src/rehearsal/rehearse.js';
import type { History } from '../../src/rehearsal/history.js';
import { decodeReplay } from '../../src/rehearsal/replay.js';
import { scenarioWith } from '../../src/rehearsal/scenario.js';
import { VERSION } from '../../src/version.js';
import { HUNTS } from './planted.js';

// Milestone 5, T6: the planted bugs. Each is a bug put back on purpose, and each must be caught by
// the invariant its row names, from random seeds of festival night, and shrunk to five faults or
// fewer. The hunts themselves run in `npm run rehearse -- --plant <bug>`, across every core; here
// each one's recorded result must still reproduce, and must be the bug's doing.

/** Festival night as `bug`'s hunt runs it, with the bug planted or not. */
function hunt(bug: Plant, plant: boolean) {
  return scenarioWith(huntOptions(festivalOptions('contract'), bug), plant ? { plant: bug } : {});
}

/** How many times a node saw a member it had seen leave or go down come back up, uid and all. */
function statusesBackwards(history: History): number {
  let backwards = 0;
  const last = new Map<string, string>();
  for (const e of history) {
    if (e.kind !== 'event' || !e.event.type.startsWith('member')) continue;
    const key = `${e.node}#${String(e.inc)} ${JSON.stringify(e.event.address)}#${JSON.stringify(e.event.uid)}`;
    const before = last.get(key);
    if (e.event.type === 'memberUp' && before !== undefined && before !== 'memberUp') backwards++;
    last.set(key, e.event.type);
  }
  return backwards;
}

describe('the planted bugs', () => {
  it('has a row for each, in the spec’s order', () => {
    expect(PLANTED.map((p) => p.name)).toEqual([
      'late-deadline',
      'early-release',
      'grants-held',
      'greets-once',
      'routes-unreachable',
      'gossip-backwards',
      'early-reply',
    ]);
    expect(PLANTED.map((p) => p.caughtBy)).toEqual([
      ['oneLiveInstance'],
      ['oneLiveInstance'],
      ['oneLiveInstance', 'acknowledgedWritesKept'],
      ['recovers'],
      ['failoverWithin'],
      ['recovers'],
      ['acknowledgedWritesKept'],
    ]);
    expect(isPlant('early-reply')).toBe(true);
    expect(isPlant('late')).toBe(false);
    expect(isPlant(3)).toBe(false);
    expect(HUNTS.map((h) => h.plant)).toEqual(
      PLANTED.filter((p) => p.tolerated === undefined).map((p) => p.name),
    );
    expect(PLANTED.filter((p) => p.tolerated !== undefined).map((p) => p.name)).toEqual([
      'gossip-backwards',
    ]);
  });

  it('keeps the scenario’s mode, and its own fault mix and timings, in a hunt', () => {
    const options = huntOptions(festivalOptions('chaos'), 'late-deadline');
    expect(options.faults).toEqual({
      only: ['slow', 'cut', 'partition'],
      perMinute: 30,
      concurrent: 3,
      network: 'chaos',
    });
    expect(options.cluster).toMatchObject({
      downAfterMs: 60_000,
      unreachableAfterMs: 1_500,
      // Festival's own lease timings, but the margin.
      leases: { ttlMs: 4_000, renewMs: 1_000, marginMs: 250 },
    });
    expect(huntOptions(festivalOptions('contract'), 'greets-once').faults).toMatchObject({
      only: ['kill', 'join', 'leave', 'reset'],
    });
    const routes = huntOptions(festivalOptions('contract'), 'routes-unreachable');
    expect(routes.cluster).toMatchObject({ downAfterMs: 10_000, leases: { ttlMs: 4_000 } });
    const plain = huntOptions(festivalOptions('contract'), 'early-reply');
    expect(plain.faults).toEqual(festivalOptions('contract').faults);
    expect(plain.cluster).toEqual(festivalOptions('contract').cluster);
  });

  describe.each(HUNTS)('$plant', ({ plant, seed, faults, invariant, line }) => {
    it(`was found within 10,000 seeds by ${invariant}, and shrunk to at most five faults`, async () => {
      expect(seed).toBeLessThanOrEqual(10_000);
      expect(planted(plant).caughtBy).toContain(invariant);
      const recorded = decodeReplay(line);
      expect(recorded).toMatchObject({ seed, mode: 'contract', plant, violation: { invariant } });
      expect(recorded.plan.length).toBeLessThanOrEqual(5);
      expect(recorded.plan.length).toBeLessThanOrEqual(faults);

      const replayed = await replay(hunt(plant, true), line);
      expect(replayed.message).toMatch(/^reproduced: /);
      expect(replayed.reproduced).toBe(true);
      expect(replayed.found?.invariant).toBe(invariant);
    }, 30_000);

    it('is the bug’s doing: without it, the same seed and plan pass that invariant', async () => {
      const { plan, untilMs } = decodeReplay(line);
      const run = await hunt(plant, false).run({
        seed,
        plan,
        ...(untilMs === undefined ? {} : { untilMs }),
      });
      expect(run.violations.filter((v) => v.invariant === invariant)).toEqual([]);
      // And the line won't run on a scenario without the bug, which can't reproduce it.
      await expect(hunt(plant, false).run({ replay: line })).rejects.toThrow(
        `recorded with the bug ${plant} planted`,
      );
    }, 30_000);
  });

  it('gossip-backwards still fires, and since keep-the-majority (0042) breaks nothing', async () => {
    // T7: six hunts of 10,000 seeds found nothing (docs/decisions/data/0043-planted-2026-11-27.json).
    // The bug is still there: members' statuses go backwards. The cluster downs each ghost again.
    const s = hunt('gossip-backwards', true);
    let backwards = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const run = await s.run({ seed });
      expect(run.violations, `seed ${String(seed)}`).toEqual([]);
      backwards += statusesBackwards(run.history);
    }
    expect(backwards).toBeGreaterThan(0);
    // Without the bug, a status never goes backwards.
    const clean = await hunt('gossip-backwards', false).run({ seed: 1 });
    expect(clean.violations).toEqual([]);
    expect(statusesBackwards(clean.history)).toBe(0);
  }, 120_000);

  it('rehearse finds the same seed and shrinks it to the same line as the script', async () => {
    const row = HUNTS.find((h) => h.plant === 'early-release');
    if (row === undefined) throw new Error('no early-release hunt');
    const report = await rehearseWith(
      hunt('early-release', true),
      { seeds: { from: 1, count: 60 }, maxFailures: 1 },
      { baseline: hunt('early-release', false), target: planted('early-release').caughtBy },
    );
    expect(report.failures.map((f) => f.seed)).toEqual([row.seed]);
    // The same line, but for the version it carries: the recorded ones are from before 1.0.
    const { version, ...shrunk } = decodeReplay(report.failures[0]?.replay ?? '');
    expect(version).toBe(VERSION);
    expect(shrunk).toEqual(decodeReplay(row.line));
    expect(report.seeds).toBe(60);
    // Seeds before it broke only what was broken already, which the baseline vouches for.
    expect(report.runs).toBeGreaterThan(row.seed);
  }, 60_000);
});
