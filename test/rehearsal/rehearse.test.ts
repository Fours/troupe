import { describe, expect, it } from 'vitest';
import { festivalOptions } from '../../demo/src/rehearsal/domain/festival.js';
import { actor } from '../../src/actor.js';
import type { Violation } from '../../src/rehearsal/invariants.js';
import type { Fault, FaultPlan } from '../../src/rehearsal/plan.js';
import { rehearse, rehearseWith, replay } from '../../src/rehearsal/rehearse.js';
import { decodeReplay, encodeReplay } from '../../src/rehearsal/replay.js';
import { scenario, scenarioInfo, scenarioWith } from '../../src/rehearsal/scenario.js';
import { shrink } from '../../src/rehearsal/shrink.js';

// Milestone 5, T6 (decision 0034): rehearse, shrinking and the replay line. A failing run is
// shrunk to the smallest plan that still fails the same invariant, every attempt a whole run from
// the same seed, and replays from one line, which says so if it doesn't reproduce.

const pause = (at: number, node: string, ms: number): Fault => ({ at, pause: node, ms });
const found = (time: number): Violation => ({ invariant: 'test', message: 'broke', time });
const WORLD = { durationMs: 60_000, quietFrom: 40_000 };

describe('shrinking', () => {
  // Fails while the plan pauses both a and b, at any length: so the shrunk plan is those two,
  // each a millisecond long, moved as late as they can go, and cut just past the violation.
  const needsAandB = (plan: FaultPlan, untilMs: number): Promise<Violation | undefined> => {
    const names = plan.map((f) => ('pause' in f ? f.pause : ''));
    const fails = names.includes('a') && names.includes('b') && untilMs >= 5_001;
    return Promise.resolve(fails ? found(5_000) : undefined);
  };

  it('keeps only the faults the failure needs, as short and late as they still fail', async () => {
    const plan = [
      pause(1_000, 'x', 4_000),
      pause(2_000, 'a', 4_000),
      pause(3_000, 'y', 4_000),
      pause(4_000, 'z', 4_000),
      pause(5_000, 'b', 6_000),
      pause(6_000, 'w', 1_000),
    ];
    const shrunk = await shrink(plan, found(5_000), WORLD, needsAandB, 500);
    expect(shrunk.plan.map((f) => ('pause' in f ? f.pause : '')).sort()).toEqual(['a', 'b']);
    // Still in order of simulation time, as a plan must be.
    expect(shrunk.plan.map((f) => f.at)).toEqual(
      [...shrunk.plan.map((f) => f.at)].sort((x, y) => x - y),
    );
    for (const f of shrunk.plan) {
      expect('ms' in f && f.ms).toBe(1);
      // As late as the quiet tail lets it, give or take the last halving.
      expect(40_000 - (f.at + 1)).toBeLessThanOrEqual(1);
    }
    expect(shrunk.untilMs).toBe(5_001);
    expect(shrunk.violation).toEqual(found(5_000));
    expect(shrunk.runs).toBeLessThan(100);
  });

  it('keeps every fault when each is needed, and stops at maxRuns', async () => {
    const plan = [pause(1_000, 'a', 4_000), pause(2_000, 'b', 4_000)];
    let calls = 0;
    const counted = async (p: FaultPlan, until: number) => {
      calls++;
      return needsAandB(p, until);
    };
    const all = await shrink(plan, found(5_000), WORLD, counted, 500);
    expect(all.plan).toHaveLength(2);
    calls = 0;
    const few = await shrink([...plan, pause(3_000, 'c', 4_000)], found(5_000), WORLD, counted, 3);
    expect(calls).toBe(3);
    expect(few.runs).toBe(3);
    // What it had when it ran out still fails.
    expect(await needsAandB(few.plan, few.untilMs)).toBeDefined();
  });

  it('shrinks a real failing run: early-release on festival night, to one fault', async () => {
    const s = scenarioWith(festivalOptions('contract'), { plant: 'early-release' });
    const report = await rehearseWith(
      s,
      { seeds: { from: 28, count: 1 } },
      { target: ['oneLiveInstance'] },
    );
    const [failure] = report.failures;
    expect(failure?.seed).toBe(28);
    expect(failure?.plan.length).toBeGreaterThan(1);
    expect(failure?.shrunk.plan.length).toBeLessThan(failure?.plan.length ?? 0);
    expect(failure?.shrunk.violation.invariant).toBe('oneLiveInstance');
    expect(failure?.shrunk.untilMs).toBeLessThan(scenarioInfo(s).durationMs);
    expect(failure?.shrunk.runs).toBeLessThanOrEqual(500);
    // The line replays it, from the same scenario.
    const replayed = await replay(s, failure?.replay ?? '');
    expect(replayed.reproduced).toBe(true);
    // Each attempt is a whole run with an edited plan, so the line holds the plan, not the seed's.
    expect(decodeReplay(failure?.replay ?? '').plan).toEqual(failure?.shrunk.plan);
  }, 60_000);
});

describe('the replay line', () => {
  it('encodes a seed, a mode, a plan, an end, a plant and a violation, seed first', () => {
    const line = {
      seed: 4217,
      mode: 'chaos' as const,
      plan: [{ at: 28_000, disk: 'slow' as const, latencyMs: [10, 20] as const, ms: 2_500 }],
      untilMs: 31_389,
      plant: 'late-deadline' as const,
      violation: {
        invariant: 'oneLiveInstance',
        message: 'show/hamlet ran on node-1 and node-3 — é ✓',
      },
    };
    const text = encodeReplay(line);
    expect(text).toMatch(/^eyJzZWVkIjo0MjE3LC[A-Za-z0-9_-]+$/);
    expect(decodeReplay(text)).toEqual(line);
    // Every length of input round-trips, whatever its padding would have been.
    for (const seed of [1, 12, 123, 1234]) {
      expect(decodeReplay(encodeReplay({ seed, mode: 'contract', plan: [] }))).toEqual({
        seed,
        mode: 'contract',
        plan: [],
      });
    }
  });

  it.each([
    [42, /not a replay line/],
    ['not base64!', /not a replay line/],
    ['e', /does not decode to JSON/],
    [encodeReplay({ seed: 1, mode: 'contract', plan: [] }).slice(0, -3), /does not decode/],
    [b64('[1]'), /to an object/],
    [b64('{"seed":1.5,"mode":"contract","plan":[]}'), /seed must be a safe integer/],
    [b64('{"seed":1,"mode":"wild","plan":[]}'), /mode must be contract or chaos/],
    [b64('{"seed":1,"mode":"chaos","plan":{}}'), /plan must be a list/],
    [b64('{"seed":1,"mode":"chaos","plan":[],"untilMs":"soon"}'), /untilMs must be an integer/],
    [b64('{"seed":1,"mode":"chaos","plan":[],"plant":4}'), /plant must be a name/],
    [b64('{"seed":1,"mode":"chaos","plan":[],"violation":{"invariant":1}}'), /violation must have/],
    [b64('{"seed":1,"mode":"chaos","plan":[],"extra":1}'), /unknown key extra/],
  ])('rejects %j', (text, message) => {
    expect(() => decodeReplay(text)).toThrow(message);
  });
});

/** Base64url of ASCII `json`, as a line would carry it. */
function b64(json: string): string {
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('replay', () => {
  const festival = scenario(festivalOptions('contract'));

  it('runs a line from scenario.run and from replay, and says it reproduced', async () => {
    const run = await festival.run({ seed: 3, plan: [], untilMs: 5_000 });
    expect(run.untilMs).toBe(5_000);
    expect(run.history.at(-1)?.time).toBe(5_000);
    expect(run.history[0]).toMatchObject({ kind: 'run', untilMs: 5_000 });
    expect(decodeReplay(run.replay)).toEqual({
      seed: 3,
      mode: 'contract',
      plan: [],
      untilMs: 5_000,
    });
    const again = await festival.run({ replay: run.replay });
    expect(JSON.stringify(again.history)).toBe(JSON.stringify(run.history));
    const replayed = await replay(festival, run.replay);
    expect(replayed).toMatchObject({ reproduced: true, recorded: undefined, found: undefined });
    expect(replayed.message).toBe(
      'reproduced: the run passed, as it did when the line was recorded',
    );
  });

  it('says so when a line doesn’t reproduce, and why that matters', async () => {
    const run = await festival.run({ seed: 3, plan: [], untilMs: 5_000 });
    const decoded = decodeReplay(run.replay);
    const wrong = encodeReplay({
      ...decoded,
      violation: { invariant: 'oneLiveInstance', message: 'show/lear ran twice' },
    });
    const replayed = await replay(festival, wrong);
    expect(replayed.reproduced).toBe(false);
    expect(replayed.recorded).toEqual({
      invariant: 'oneLiveInstance',
      message: 'show/lear ran twice',
    });
    expect(replayed.message).toMatch(
      /^didn't reproduce: the line recorded oneLiveInstance: show\/lear ran twice, and this run found nothing\. .*isn't deterministic.*Date\.now, Math\.random or a real timer/,
    );
    // A line from a run that failed, replayed where the run passes.
    const failing = await scenarioWith(festivalOptions('contract'), { plant: 'grants-held' }).run({
      seed: 1,
      plan: [],
      untilMs: 2_006,
    });
    expect(failing.violations.length).toBeGreaterThan(0);
    const unplanted = encodeReplay({ ...decodeReplay(failing.replay), plant: undefined } as never);
    const passed = await replay(festival, unplanted);
    expect(passed.reproduced).toBe(false);
    // And one from a run that passed, replayed where it fails.
    const strict = scenario({
      ...festivalOptions('contract'),
      invariants: [{ name: 'never', check: () => [found(1)] }],
    });
    const fails = await replay(strict, run.replay);
    expect(fails.reproduced).toBe(false);
    expect(fails.message).toMatch(/recorded a run that passed, and this one found test: broke/);
  });

  it('throws for a line it can’t run on the scenario, before anything starts', async () => {
    const run = await festival.run({ seed: 3, plan: [], untilMs: 1_000 });
    const chaos = scenario(festivalOptions('chaos'));
    await expect(chaos.run({ replay: run.replay })).rejects.toThrow(
      /recorded with the network in contract mode, and this scenario's is in chaos mode/,
    );
    const planted = scenarioWith(festivalOptions('contract'), { plant: 'early-reply' });
    await expect(planted.run({ replay: run.replay })).rejects.toThrow(
      /recorded with no bug planted, and this scenario has early-reply planted/,
    );
    await expect(festival.run({ replay: 'nope!' })).rejects.toThrow(/not a replay line/);
    await expect(festival.run({ replay: run.replay, seed: 1 })).rejects.toThrow(/seed/);
    await expect(festival.run({ seed: 1, untilMs: 60_001 })).rejects.toThrow(
      /untilMs must be at most durationMs, 60000, got 60001/,
    );
    await expect(festival.run({ seed: 1, untilMs: 0 })).rejects.toThrow(/untilMs/);
    const badPlan = encodeReplay({ seed: 1, mode: 'contract', plan: [{ at: 1 } as never] });
    await expect(festival.run({ replay: badPlan })).rejects.toThrow(/plan\[0\]/);
  });
});

describe('rehearse', () => {
  it('runs each seed, shrinks each failure, and counts what it found', async () => {
    const s = scenarioWith(festivalOptions('contract'), { plant: 'grants-held' });
    const seen: number[] = [];
    const report = await rehearse(s, {
      seeds: { from: 1, count: 3 },
      maxShrinkRuns: 20,
      determinismEvery: 2,
      onSeed: (r) => seen.push(r.seed),
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(report.seeds).toBe(3);
    expect(report.failing.oneLiveInstance).toBeGreaterThan(0);
    expect(report.failures.length).toBeGreaterThan(0);
    for (const failure of report.failures) {
      expect(failure.invariant).toBe(failure.violations[0]?.invariant);
      expect(failure.shrunk.runs).toBeLessThanOrEqual(20);
      expect((await replay(s, failure.replay)).reproduced).toBe(true);
    }
    expect(report.nondeterministic).toEqual([]);
    expect(report.runs).toBeGreaterThan(3 + 1);
  }, 60_000);

  it('counts ignored invariants without failing on them, and stops at maxFailures', async () => {
    const s = scenarioWith(festivalOptions('contract'), { plant: 'grants-held' });
    const ignored = await rehearse(s, {
      seeds: { from: 1, count: 2 },
      ignore: ['oneLiveInstance', 'acknowledgedWritesKept', 'noStaleReads', 'recovers'],
      maxShrinkRuns: 0,
    });
    expect(ignored.failing.oneLiveInstance).toBeGreaterThan(0);
    expect(ignored.failures).toEqual([]);
    const first = await rehearse(s, {
      seeds: { from: 1, count: 5 },
      maxFailures: 1,
      maxShrinkRuns: 0,
    });
    expect(first.failures).toHaveLength(1);
    expect(first.failures[0]?.shrunk.runs).toBe(0);
  }, 60_000);

  it('counts a violation only where the baseline passes that invariant', async () => {
    const s = scenarioWith(festivalOptions('contract'), { plant: 'grants-held' });
    const opts = { seeds: { from: 1, count: 2 }, maxShrinkRuns: 0 } as const;
    // A baseline with the same bug breaks the same invariants, so nothing is the bug's doing.
    const same = await rehearseWith(s, opts, { baseline: s });
    expect(same.failing.oneLiveInstance).toBeGreaterThan(0);
    expect(same.failures).toEqual([]);
    // Without the bug, the baseline passes them, and the seed fails.
    const clean = await rehearseWith(s, opts, {
      baseline: scenario(festivalOptions('contract')),
      target: ['oneLiveInstance'],
    });
    expect(clean.failures.length).toBeGreaterThan(0);
    for (const f of clean.failures) {
      expect(f.violations.every((v) => v.invariant === 'oneLiveInstance')).toBe(true);
    }
  }, 60_000);

  it('finds a seed whose two runs differ', async () => {
    // A workload that reads state outside the run, which a scenario mustn't.
    let calls = 0;
    const base = festivalOptions('contract');
    const s = scenario({
      ...base,
      durationMs: 3_000,
      workload: (ctx) => {
        calls++;
        if (calls % 7 === 0) base.workload?.(ctx);
      },
    });
    const report = await rehearse(s, { seeds: { from: 1, count: 2 }, determinismEvery: 1 });
    expect(report.nondeterministic.length).toBeGreaterThan(0);
  }, 30_000);

  it('fails, shrinks and replays a stall as the violation stall', async () => {
    const s = scenario({
      nodes: ['node-1'],
      durationMs: 5_000,
      stallAfterMs: 1_000,
      setup: ({ system, inc }) => {
        if (inc > 0) return undefined;
        const stuck = system.spawn(
          actor<'go', null>({
            initial: null,
            // Waits on something outside the simulation, which time can never reach.
            receive: async (state) => {
              await new Promise(() => {});
              return state;
            },
          }),
          'stuck',
        );
        stuck.tell('go');
        return undefined;
      },
    });
    const report = await rehearse(s, { seeds: { from: 1, count: 1 } });
    expect(report.failing.stall).toBe(1);
    expect(report.failures[0]?.invariant).toBe('stall');
    expect(report.failures[0]?.shrunk.violation.message).toMatch(/\/user\/stuck/);
    const replayed = await replay(s, report.failures[0]?.replay ?? '');
    expect(replayed.reproduced).toBe(true);
    expect(replayed.run).toBeUndefined();
  });

  it.each([
    [{}, /seeds must be/],
    [{ seeds: { from: 1 } }, /seeds.count/],
    [{ seeds: { from: 1.5, count: 1 } }, /seeds.from must be a safe integer/],
    [{ seeds: { from: 1, count: 1, to: 3 } }, /unknown/],
    [{ seeds: { from: 1, count: 1 }, ignore: 'recovers' }, /ignore must be a list/],
    [{ seeds: { from: 1, count: 1 }, maxFailures: 0 }, /maxFailures/],
    [{ seeds: { from: 1, count: 1 }, maxShrinkRuns: -1 }, /maxShrinkRuns/],
    [{ seeds: { from: 1, count: 1 }, determinismEvery: 0.5 }, /determinismEvery/],
    [{ seeds: { from: 1, count: 1 }, onSeed: 3 }, /onSeed must be a function/],
    [{ seeds: { from: 1, count: 1 }, workers: 4 }, /unknown/],
  ])('throws for %j', async (opts, message) => {
    await expect(rehearse(scenario(festivalOptions('contract')), opts as never)).rejects.toThrow(
      message,
    );
  });

  it('throws for a scenario scenario() didn’t make', () => {
    const fake = {
      mode: 'contract' as const,
      plan: () => [],
      run: () => Promise.reject(new Error('no')),
    };
    expect(() => scenarioInfo(fake)).toThrow(/not a scenario made by scenario\(\)/);
  });
});
