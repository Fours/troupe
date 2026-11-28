import { describe, expect, it } from 'vitest';
import {
  CAPACITY,
  DURATION_MS,
  faultsOf,
  festival,
  festivalInvariants,
  isMix,
  MIXES,
  soldIn,
} from '../../demo/src/rehearsal/domain/festival.js';

// Milestone 5, T5: festival night, rehearsed. The lineup's shows on three nodes, a spare and a
// crowd that buys seats and asks how many are sold, under faults drawn from each seed.

const SEEDS = Number(process.env.FESTIVAL_SEEDS ?? 100);

describe('festival night, rehearsed', () => {
  it.each(['contract', 'chaos'] as const)(
    'passes every invariant with no faults, in %s mode',
    async (mode) => {
      const run = await festival({ mode }).run({ seed: 1, plan: [] });
      expect(run.violations).toEqual([]);
      const ops = run.history.filter((e) => e.kind === 'invoke');
      const ok = run.history.filter((e) => e.kind === 'complete' && e.outcome === 'ok');
      // A minute of a crowd, every op answered: buys confirmed, statuses read.
      expect(ops.length).toBeGreaterThan(300);
      expect(ok.length).toBeGreaterThan(ops.length - 5);
      const buys = ok.filter((e) => e.kind === 'complete' && soldIn(e.reply) !== undefined);
      expect(buys.length).toBeGreaterThan(200);
      expect(run.history.at(-1)?.time).toBe(DURATION_MS);
    },
  );

  it.each(['contract', 'chaos'] as const)(
    `passes every invariant over ${String(SEEDS)} seeds, in %s mode`,
    async (mode) => {
      // Since T7's hunt: recovering, failing over and keeping order too, not only safety.
      const s = festival({ mode });
      const kinds = new Set<string>();
      for (let seed = 1; seed <= SEEDS; seed++) {
        const run = await s.run({ seed });
        for (const fault of run.plan) kinds.add(Object.keys(fault)[1] ?? '');
        expect(run.violations, `seed ${String(seed)}`).toEqual([]);
        expect(run.expected).toEqual([]);
      }
      // Every group of faults turned up: nodes, clocks, the network and the database.
      for (const kind of ['kill', 'pause', 'drift', 'jump', 'partition', 'disk', 'cut']) {
        expect(kinds, kind).toContain(kind);
      }
      if (mode === 'chaos')
        expect([...kinds].some((k) => k === 'lose' || k === 'duplicate')).toBe(true);
    },
    300_000,
  );

  it('checks order and at-most-once only in contract mode', () => {
    const names = (mode: 'contract' | 'chaos') => festivalInvariants(mode).map((i) => i.name);
    expect(names('contract')).toEqual([
      'oneLiveInstance',
      'acknowledgedWritesKept',
      'noStaleReads',
      'recovers',
      'failoverWithin',
      'atMostOnce',
      'orderPerPair',
    ]);
    expect(names('chaos')).toEqual(names('contract').slice(0, 5));
    expect(festival({ mode: 'chaos' }).mode).toBe('chaos');
  });

  it('draws faults of every group from its seeds, and repeats a seed byte for byte', async () => {
    const s = festival();
    const plan = s.plan(5);
    expect(plan.length).toBeGreaterThan(0);
    const first = await s.run({ seed: 5 });
    const second = await s.run({ seed: 5 });
    expect(JSON.stringify(second.history)).toBe(JSON.stringify(first.history));
    expect(first.plan).toEqual(plan);
  });

  it('draws each fault mix’s own kinds, at its own rate, in both modes', () => {
    expect(MIXES).toEqual(['all', 'nodes', 'network', 'clocks', 'heavy']);
    expect(isMix('heavy')).toBe(true);
    expect(isMix('everything')).toBe(false);
    const kindsOf = (mode: 'contract' | 'chaos', mix: (typeof MIXES)[number]): string[] => {
      const s = festival({ mode, mix });
      const kinds = new Set<string>();
      for (let seed = 1; seed <= 200; seed++) {
        for (const fault of s.plan(seed)) {
          const key = Object.keys(fault)[1] ?? '';
          kinds.add(key === 'disk' ? 'disk' : key);
        }
      }
      return [...kinds].sort();
    };
    expect(kindsOf('contract', 'nodes')).toEqual(['cut', 'disk', 'join', 'kill', 'leave', 'pause']);
    expect(kindsOf('contract', 'network')).toEqual(['delay', 'partition', 'reorder', 'reset']);
    expect(kindsOf('chaos', 'network')).toEqual([
      'delay',
      'duplicate',
      'lose',
      'partition',
      'reorder',
      'reset',
    ]);
    expect(kindsOf('contract', 'clocks')).toEqual(['cut', 'disk', 'drift', 'jump']);
    expect(kindsOf('chaos', 'all')).toEqual(kindsOf('chaos', 'heavy'));
    // The heavy mix: twice the rate, three at once.
    expect(faultsOf('chaos', 'heavy')).toMatchObject({ perMinute: 12, concurrent: 3 });
    const count = (mix: (typeof MIXES)[number]): number => {
      const s = festival({ mix });
      let n = 0;
      for (let seed = 1; seed <= 200; seed++) n += s.plan(seed).length;
      return n;
    };
    expect(count('heavy')).toBeGreaterThan(count('all') * 1.5);
  });

  it('reads a position from confirms and statuses, and nothing else', () => {
    expect(soldIn({ kind: 'confirm', ok: true, show: 'lear', seats: 1, sold: 4 })).toBe(4);
    expect(soldIn({ ok: true, capacity: CAPACITY, sold: 9, held: 0 })).toBe(9);
    expect(soldIn({ kind: 'hold', ok: false, show: 'lear', reason: 'sold out' })).toBeUndefined();
    expect(soldIn({ kind: 'hold', ok: true, sold: 3 })).toBeUndefined();
    expect(soldIn(null)).toBeUndefined();
    expect(soldIn(3)).toBeUndefined();
  });
});
