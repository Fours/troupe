import { describe, expect, it } from 'vitest';
import type { Connection, Transport } from '../../src/cluster/transport.js';
import {
  simulatedNetwork,
  type NetworkMode,
  type SimulatedNetwork,
  type SimulatedNetworkOptions,
} from '../../src/rehearsal/network.js';
import { ManualScheduler } from '../../src/testkit/manual-scheduler.js';
import { seededRandom } from '../../src/testkit/random.js';

// Milestone 5, T2 (decision 0035): the simulated network on its own, on raw transports.

type Options = Partial<Omit<SimulatedNetworkOptions, 'scheduler' | 'random'>>;

function setup(opts: Options = {}, seed = 1) {
  const scheduler = new ManualScheduler();
  const network = simulatedNetwork({ scheduler, random: seededRandom(seed), ...opts });
  const run = (ms: number): void => {
    scheduler.advanceTo(scheduler.now() + ms);
  };
  return { scheduler, network, run };
}

/** Records what a connection sees, and when. */
function record(connection: Connection, scheduler: ManualScheduler) {
  const frames: string[] = [];
  const times: number[] = [];
  const closes: unknown[] = [];
  connection.onFrame((frame) => {
    frames.push(frame);
    times.push(scheduler.now());
  });
  connection.onClose((...args) => closes.push(args.length === 0 ? 'clean' : String(args[0])));
  return { frames, times, closes };
}

/** A node that listens, and records every connection it accepts. */
async function listener(network: SimulatedNetwork, address: string, scheduler: ManualScheduler) {
  const accepted: { connection: Connection; seen: ReturnType<typeof record> }[] = [];
  const transport = network.transport(address);
  await transport.listen((connection) => {
    accepted.push({ connection, seen: record(connection, scheduler) });
  });
  return { transport, accepted };
}

async function pair(opts: Options = {}, seed = 1) {
  const net = setup(opts, seed);
  const server = await listener(net.network, 'b', net.scheduler);
  const client = net.network.transport('a');
  const out = client.connect('b');
  const back = record(out, net.scheduler);
  const accepted = () => {
    const first = server.accepted[0];
    if (first === undefined) throw new Error('nothing accepted');
    return first;
  };
  return { ...net, server, client, out, back, accepted };
}

const numbers = (n: number, prefix = ''): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`);

describe('simulatedNetwork, with no faults', () => {
  it('opens after a drawn latency, and delivers frames in order, each within the range', async () => {
    const { network, run, scheduler } = setup({ latencyMs: [2, 9] });
    const server = await listener(network, 'b', scheduler);
    const out = network.transport('a').connect('b');
    const sentAt: number[] = [];
    for (let i = 0; i < 200; i++) {
      out.send(String(i));
      sentAt.push(scheduler.now());
      run(1);
    }
    run(20);
    const seen = server.accepted[0]?.seen;
    expect(seen?.frames).toEqual(numbers(200));
    // Never sooner than the fastest latency, and never later than the slowest, unless it waited
    // behind a frame sent before it.
    const latencies = (seen?.times ?? []).map((t, i) => t - (sentAt[i] ?? 0));
    expect(Math.min(...latencies)).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < latencies.length; i++) {
      const waited = (seen?.times[i] ?? 0) === (seen?.times[i - 1] ?? 0);
      if (!waited) expect(latencies[i]).toBeLessThanOrEqual(9);
    }
    // The latencies vary.
    expect(new Set(latencies).size).toBeGreaterThan(3);
    expect(network.counts()).toMatchObject({ sent: 200, delivered: 200, lost: 0, held: 0 });
  });

  it('delivers frames sent before it opened just after the open, in order', async () => {
    const { run, out, accepted } = await pair({ latencyMs: [5, 5] });
    for (const frame of numbers(100)) out.send(frame);
    run(4);
    expect(() => accepted()).toThrow();
    run(1);
    expect(accepted().seen.frames).toEqual(numbers(100));
  });

  it('closes a dial to an address where nothing listens with an error', () => {
    const { network, run, scheduler } = setup();
    const out = network.transport('a').connect('nowhere');
    const seen = record(out, scheduler);
    run(10);
    expect(seen.closes).toEqual(['Error: nothing listens at nowhere']);
  });

  it('delivers what was sent before a close, then closes the other end cleanly', async () => {
    const { run, out, accepted, back } = await pair();
    run(10);
    for (const frame of numbers(50)) out.send(frame);
    out.close();
    out.send('after');
    run(20);
    expect(accepted().seen.frames).toEqual(numbers(50));
    expect(accepted().seen.closes).toEqual(['clean']);
    expect(back.closes).toEqual(['clean']);
  });

  it('kill loses frames in flight both ways, resets the other end, and frees the address', async () => {
    const { network, run, out, accepted, back, scheduler } = await pair({ latencyMs: [5, 5] });
    run(10);
    out.send('to b');
    accepted().connection.send('to a');
    run(2);
    network.kill('a');
    run(10);
    expect(accepted().seen.frames).toEqual([]);
    expect(back.frames).toEqual([]);
    expect(accepted().seen.closes).toEqual(['Error: the connection to a was reset']);
    // The killed end is told nothing.
    expect(back.closes).toEqual([]);
    const again = network.transport('a');
    const second = record(again.connect('b'), scheduler);
    run(10);
    expect(second.closes).toEqual([]);
  });

  it('a closed transport closes its connections, refuses to listen, and frees its address', async () => {
    const { network, run, client, accepted, back, scheduler } = await pair();
    run(10);
    await client.close();
    run(10);
    expect(back.closes).toEqual(['clean']);
    expect(accepted().seen.closes).toEqual(['clean']);
    await expect(client.listen(() => undefined)).rejects.toThrow('a has closed');
    const dead = record(client.connect('b'), scheduler);
    run(1);
    expect(dead.closes).toEqual(['Error: a has closed']);
    expect(() => network.transport('a')).not.toThrow();
  });

  it('refuses a second live transport at one address, and a second listen', async () => {
    const { network } = setup();
    const t = network.transport('a');
    expect(() => network.transport('a')).toThrow('a already has a live transport');
    await t.listen(() => undefined);
    await expect(t.listen(() => undefined)).rejects.toThrow('already listening');
  });

  it('tells a listener added after the close, on the scheduler', async () => {
    const { run, out, scheduler } = await pair();
    run(10);
    out.close();
    run(10);
    const late = record(out, scheduler);
    expect(late.closes).toEqual([]);
    run(0);
    scheduler.runReady();
    expect(late.closes).toEqual(['clean']);
  });

  it('repeats exactly from one seed, and differs on another', async () => {
    const arrivals = async (seed: number) => {
      const { run, out, accepted } = await pair({ latencyMs: [1, 20] }, seed);
      for (const frame of numbers(50)) {
        out.send(frame);
        run(1);
      }
      run(50);
      return accepted().seen.times;
    };
    expect(await arrivals(7)).toEqual(await arrivals(7));
    expect(await arrivals(7)).not.toEqual(await arrivals(8));
  });
});

describe('partitions', () => {
  it('in contract mode, hold frames both ways, and deliver them in order when they heal', async () => {
    const { network, run, out, accepted, back } = await pair();
    run(10);
    const heal = network.partition(['a'], ['b']);
    for (const frame of numbers(20)) out.send(frame);
    for (const frame of numbers(20, 'r')) accepted().connection.send(frame);
    run(5_000);
    expect(accepted().seen.frames).toEqual([]);
    expect(back.frames).toEqual([]);
    // As with a dropped cable, the connections see nothing.
    expect(accepted().seen.closes).toEqual([]);
    expect(back.closes).toEqual([]);
    heal();
    out.send('after');
    run(10);
    expect(accepted().seen.frames).toEqual([...numbers(20), 'after']);
    expect(back.frames).toEqual(numbers(20, 'r'));
    expect(network.counts()).toMatchObject({ held: 40, lost: 0, timedOut: 0 });
  });

  it('one way, hold only what goes from the cut side', async () => {
    const { network, run, out, accepted, back } = await pair();
    run(10);
    const heal = network.partition(['a'], ['b'], { oneWay: true });
    out.send('a to b');
    accepted().connection.send('b to a');
    run(100);
    expect(accepted().seen.frames).toEqual([]);
    expect(back.frames).toEqual(['b to a']);
    heal();
    run(10);
    expect(accepted().seen.frames).toEqual(['a to b']);
  });

  it('reset a connection that holds frames for resetAfterMs, losing them, at both ends', async () => {
    const { network, run, out, accepted, back } = await pair({ resetAfterMs: 2_000 });
    run(10);
    const heal = network.partition(['b'], ['a']);
    out.send('held');
    run(1_999);
    expect(back.closes).toEqual([]);
    run(1);
    expect(back.closes).toEqual(['Error: the connection to b timed out']);
    expect(accepted().seen.closes).toEqual(['Error: the connection to a timed out']);
    heal();
    run(10);
    expect(accepted().seen.frames).toEqual([]);
    expect(network.counts().timedOut).toBe(1);
  });

  it('leave an idle connection alone, however long they last', async () => {
    const { network, run, out, accepted, back } = await pair({ resetAfterMs: 2_000 });
    run(10);
    const heal = network.partition(['a'], ['b']);
    run(60_000);
    heal();
    out.send('still open');
    run(10);
    expect(back.closes).toEqual([]);
    expect(accepted().seen.frames).toEqual(['still open']);
  });

  it('hold a dial across them, which opens when they heal, or fails after resetAfterMs', async () => {
    const { network, run, scheduler } = setup({ resetAfterMs: 2_000 });
    const server = await listener(network, 'b', scheduler);
    const client = network.transport('a');
    const heal = network.partition(['a', 'c'], ['b']);
    const first = client.connect('b');
    first.send('first');
    run(1_000);
    expect(server.accepted).toHaveLength(0);
    heal();
    run(10);
    expect(server.accepted[0]?.seen.frames).toEqual(['first']);
    network.partition(['a'], ['b']);
    const second = record(client.connect('b'), scheduler);
    run(2_000);
    expect(second.closes).toEqual(['Error: the connection to b timed out']);
    expect(server.accepted).toHaveLength(1);
  });

  it('only stop frames between their sides', async () => {
    const { network, run, scheduler } = setup();
    const b = await listener(network, 'b', scheduler);
    const c = await listener(network, 'c', scheduler);
    const a = network.transport('a');
    const toB = a.connect('b');
    const toC = a.connect('c');
    run(10);
    network.partition(['a'], ['b']);
    toB.send('cut');
    toC.send('fine');
    run(10);
    expect(b.accepted[0]?.seen.frames).toEqual([]);
    expect(c.accepted[0]?.seen.frames).toEqual(['fine']);
  });

  it('keep frames held while one of two overlapping partitions still stands', async () => {
    const { network, run, out, accepted } = await pair();
    run(10);
    const first = network.partition(['a'], ['b']);
    const second = network.partition(['a', 'c'], ['b']);
    out.send('held');
    first();
    first();
    run(10);
    expect(accepted().seen.frames).toEqual([]);
    second();
    run(10);
    expect(accepted().seen.frames).toEqual(['held']);
  });

  it('hold a close and a kill’s reset too, which arrive when they heal', async () => {
    const { network, run, out, accepted, scheduler } = await pair();
    const other = await listener(network, 'c', scheduler);
    const toC = network.transport('d').connect('c');
    run(10);
    const heal = network.partition(['a', 'd'], ['b', 'c']);
    out.send('last');
    out.close();
    network.kill('d');
    run(100);
    expect(accepted().seen.closes).toEqual([]);
    expect(other.accepted[0]?.seen.closes).toEqual([]);
    heal();
    run(10);
    expect(accepted().seen.frames).toEqual(['last']);
    expect(accepted().seen.closes).toEqual(['clean']);
    expect(other.accepted[0]?.seen.closes).toEqual(['Error: the connection to d was reset']);
    toC.send('from the dead');
    run(10);
    expect(other.accepted[0]?.seen.frames).toEqual([]);
  });

  it('in chaos mode, lose the frames they cut, and leave the connection open', async () => {
    const { network, run, out, accepted, back } = await pair({ mode: 'chaos' });
    run(10);
    const heal = network.partition(['a'], ['b']);
    out.send('lost');
    run(20_000);
    heal();
    out.send('after');
    run(10);
    expect(accepted().seen.frames).toEqual(['after']);
    expect(back.closes).toEqual([]);
    expect(network.counts()).toMatchObject({ lost: 1, held: 0 });
  });
});

describe('resets', () => {
  it('close every connection between two nodes with an error, losing what was on its way', async () => {
    const { network, run, scheduler } = setup({ latencyMs: [5, 5] });
    const b = await listener(network, 'b', scheduler);
    const c = await listener(network, 'c', scheduler);
    const a = network.transport('a');
    const toB = record(a.connect('b'), scheduler);
    const toC = a.connect('c');
    const out = a.connect('b');
    run(10);
    out.send('in flight');
    toC.send('fine');
    run(2);
    network.reset('b', 'a');
    run(10);
    expect(toB.closes).toEqual(['Error: the connection to b was reset']);
    expect(b.accepted.map((x) => x.seen.closes)).toEqual([
      ['Error: the connection to a was reset'],
      ['Error: the connection to a was reset'],
    ]);
    expect(b.accepted[1]?.seen.frames).toEqual([]);
    expect(c.accepted[0]?.seen.frames).toEqual(['fine']);
    expect(network.counts().resets).toBe(2);
    // An address can be reset when nothing connects it.
    network.reset('a', 'nobody');
  });

  it('fail a dial still on its way', async () => {
    const { network, run, scheduler } = setup({ latencyMs: [5, 5] });
    const b = await listener(network, 'b', scheduler);
    const out = record(network.transport('a').connect('b'), scheduler);
    run(1);
    network.reset('a', 'b');
    run(10);
    expect(out.closes).toEqual(['Error: the connection to b was reset']);
    expect(b.accepted).toHaveLength(0);
  });
});

describe('delay and reorder', () => {
  it('delay draws a node’s latency from its range, both ways, and keeps frames in order', async () => {
    const { network, run, scheduler } = setup({ latencyMs: [1, 1] });
    const b = await listener(network, 'b', scheduler);
    const c = await listener(network, 'c', scheduler);
    const a = network.transport('a');
    const toB = a.connect('b');
    const toC = a.connect('c');
    run(10);
    const end = network.delay({ node: 'b', latencyMs: [50, 100] });
    const at = scheduler.now();
    for (const frame of numbers(30)) {
      toB.send(frame);
      toC.send(frame);
    }
    b.accepted[0]?.connection.send('back');
    const back = record(toB, scheduler);
    run(200);
    expect(b.accepted[0]?.seen.frames).toEqual(numbers(30));
    expect(Math.min(...(b.accepted[0]?.seen.times ?? []))).toBeGreaterThanOrEqual(at + 50);
    expect(Math.max(...(b.accepted[0]?.seen.times ?? []))).toBeLessThanOrEqual(at + 100);
    expect(back.times[0]).toBeGreaterThanOrEqual(at + 50);
    expect(new Set(c.accepted[0]?.seen.times)).toEqual(new Set([at + 1]));
    end();
    end();
    const after = scheduler.now();
    toB.send('quick');
    run(1);
    expect(b.accepted[0]?.seen.times.at(-1)).toBe(after + 1);
  });

  it('delay can pick one pair, and the longer of two delays wins', async () => {
    const { network, run, scheduler } = setup({ latencyMs: [1, 1] });
    const b = await listener(network, 'b', scheduler);
    const c = await listener(network, 'c', scheduler);
    const a = network.transport('a');
    const toB = a.connect('b');
    const toC = a.connect('c');
    run(10);
    network.delay({ node: 'a', peer: 'b', latencyMs: [10, 10] });
    network.delay({ node: 'b', latencyMs: [30, 30] });
    const at = scheduler.now();
    toB.send('x');
    toC.send('y');
    run(50);
    expect(b.accepted[0]?.seen.times).toEqual([at + 30]);
    expect(c.accepted[0]?.seen.times).toEqual([at + 1]);
  });

  it('reorder lets frames on different connections overtake each other, never within one', async () => {
    const { network, run, scheduler } = setup({ latencyMs: [1, 1] });
    const b = await listener(network, 'b', scheduler);
    const order: string[] = [];
    const senders = ['a', 'c', 'd'].map((name) => network.transport(name).connect('b'));
    run(10);
    for (const accepted of b.accepted) accepted.connection.onFrame((f) => order.push(f));
    network.reorder({ node: 'b', windowMs: 40 });
    for (let i = 0; i < 100; i++) {
      for (const [n, sender] of senders.entries()) sender.send(`${String(n)}:${String(i)}`);
    }
    run(100);
    // Within each connection, in order.
    for (const accepted of b.accepted) {
      const seqs = accepted.seen.frames.map((f) => Number(f.split(':')[1]));
      expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i));
    }
    // Across them, not in the order they were sent.
    const sent = Array.from({ length: 100 }, (_, i) =>
      [0, 1, 2].map((n) => `${String(n)}:${String(i)}`),
    ).flat();
    expect(order).toHaveLength(300);
    expect(order).not.toEqual(sent);
    expect(network.counts().overtaken).toBe(0);
  });
});

describe('chaos mode', () => {
  it('loses single frames, leaving the connection open', async () => {
    const { network, run, out, accepted, back } = await pair({ mode: 'chaos' });
    run(10);
    network.lose({ node: 'a', rate: 0.3 });
    for (const frame of numbers(200)) out.send(frame);
    run(20);
    const got = accepted().seen.frames;
    expect(got.length).toBeGreaterThan(100);
    expect(got.length).toBeLessThan(180);
    // What arrives is in order, with gaps.
    expect(got.map(Number)).toEqual([...got.map(Number)].sort((x, y) => x - y));
    expect(back.closes).toEqual([]);
    expect(network.counts().lost).toBe(200 - got.length);
  });

  it('reorders frames within one connection', async () => {
    const { network, run, out, accepted } = await pair({ mode: 'chaos' });
    run(10);
    network.reorder({ node: 'a', windowMs: 30, within: true });
    for (const frame of numbers(200)) out.send(frame);
    run(50);
    const got = accepted().seen.frames;
    expect([...got].sort((x, y) => Number(x) - Number(y))).toEqual(numbers(200));
    expect(got).not.toEqual(numbers(200));
    expect(network.counts().overtaken).toBeGreaterThan(0);
  });

  it('repeats frames', async () => {
    const { network, run, out, accepted } = await pair({ mode: 'chaos' });
    run(10);
    const end = network.duplicate({ node: 'b', peer: 'a', rate: 0.5 });
    for (const frame of numbers(100)) out.send(frame);
    run(20);
    const got = accepted().seen.frames;
    expect(new Set(got)).toEqual(new Set(numbers(100)));
    expect(got.length).toBeGreaterThan(120);
    expect(network.counts().duplicated).toBe(got.length - 100);
    end();
    out.send('once');
    run(10);
    expect(got.filter((f) => f === 'once')).toHaveLength(1);
  });

  it('never loses or reorders opens and closes', async () => {
    const { network, run, scheduler } = setup({ mode: 'chaos' });
    const b = await listener(network, 'b', scheduler);
    network.lose({ node: 'a', rate: 1 });
    network.reorder({ node: 'a', windowMs: 50, within: true });
    const out = network.transport('a').connect('b');
    out.send('lost');
    run(200);
    expect(b.accepted).toHaveLength(1);
    out.close();
    run(200);
    expect(b.accepted[0]?.seen.frames).toEqual([]);
    expect(b.accepted[0]?.seen.closes).toEqual(['clean']);
  });

  it('is refused in contract mode, when the fault is asked for', () => {
    const { network } = setup();
    expect(() => network.lose({ node: 'a', rate: 0.1 })).toThrow(/chaos mode only/);
    expect(() => network.duplicate({ node: 'a', rate: 0.1 })).toThrow(/chaos mode only/);
    expect(() => network.reorder({ node: 'a', windowMs: 5, within: true })).toThrow(
      /chaos mode only/,
    );
    expect(() => network.reorder({ node: 'a', windowMs: 5 })).not.toThrow();
  });
});

describe('options', () => {
  it('are checked where they are passed in', () => {
    const scheduler = new ManualScheduler();
    const random = seededRandom(1);
    const bad = (opts: Record<string, unknown>) => () =>
      simulatedNetwork({ scheduler, random, ...opts });
    expect(bad({ extra: 1 })).toThrow('unknown option "extra"');
    expect(bad({ scheduler: {} })).toThrow('scheduler must be a Scheduler');
    expect(bad({ random: 4 })).toThrow('random must be a function');
    expect(bad({ mode: 'tcp' })).toThrow('mode must be "contract" or "chaos"');
    expect(bad({ latencyMs: 3 })).toThrow('latencyMs must be [min, max]');
    expect(bad({ latencyMs: [3, 1] })).toThrow('min at most max');
    expect(bad({ latencyMs: [-1, 1] })).toThrow('non-negative integer');
    expect(bad({ resetAfterMs: 0 })).toThrow('resetAfterMs must be a positive integer');
    const network = simulatedNetwork({ scheduler, random, mode: 'chaos' });
    expect(() => network.transport('')).toThrow('non-empty string');
    expect(() => network.partition([], ['a'])).toThrow('non-empty list');
    expect(() => network.partition(['a', 'b'], ['b'])).toThrow('b is on both sides');
    expect(() => network.partition(['a'], [''])).toThrow('non-empty string');
    expect(() => network.partition(['a'], ['b'], { oneWay: 1 } as never)).toThrow('boolean');
    expect(() => network.partition(['a'], ['b'], { both: true } as never)).toThrow('unknown');
    expect(() => {
      network.reset('a', 3 as never);
    }).toThrow('non-empty string');
    expect(() => network.delay({ node: 'a', latencyMs: [5, 1] })).toThrow('min at most max');
    expect(() => network.delay({ node: '', latencyMs: [1, 1] })).toThrow('node');
    expect(() => network.delay({ node: 'a', peer: '', latencyMs: [1, 1] })).toThrow('peer');
    expect(() => network.reorder({ node: 'a', windowMs: 0 })).toThrow('windowMs');
    expect(() => network.reorder({ node: 'a', windowMs: 5, within: 'yes' } as never)).toThrow(
      'boolean',
    );
    expect(() => network.lose({ node: 'a', rate: 0 })).toThrow('rate must be');
    expect(() => network.duplicate({ node: 'a', rate: 1.5 })).toThrow('rate must be');
    expect(() => network.lose({ node: 'a', rate: 0.5, extra: 1 } as never)).toThrow('unknown');
  });
});

/**
 * The contract-mode property: over random faults, what arrives on each end of every connection is
 * always the start of what was sent on the other, in order, with nothing skipped or repeated, and
 * an end that got less than everything has seen its close.
 */
describe('contract mode, as a property over random faults', () => {
  const NODES = ['n1', 'n2', 'n3', 'n4'];

  interface Side {
    readonly sent: number[];
    readonly got: number[];
    closed: boolean;
    // Its node was killed, so it hears nothing more.
    gone: boolean;
    readonly connection: Connection;
  }

  async function trial(seed: number, mode: NetworkMode = 'contract') {
    const chance = seededRandom(seed * 31 + 7);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(chance() * items.length)] as T;
    const { network, run } = setup(
      { mode, latencyMs: [1, 8], resetAfterMs: 500 + Math.floor(chance() * 2_000) },
      seed,
    );
    // Each connection's two sides, by its id: the dialer's, and the acceptor's once it opens.
    const links = new Map<number, { dialer: Side; acceptor: Side | undefined; nodes: string[] }>();
    const transports = new Map<string, Transport>();
    const side = (connection: Connection, onFirst?: (id: number) => void): Side => {
      const s: Side = { sent: [], got: [], closed: false, gone: false, connection };
      connection.onFrame((frame) => {
        const [id, seq] = frame.split(':').map(Number) as [number, number];
        onFirst?.(id);
        s.got.push(seq);
      });
      connection.onClose(() => {
        s.closed = true;
      });
      return s;
    };
    const start = async (name: string) => {
      const t = network.transport(name);
      transports.set(name, t);
      await t.listen((connection) => {
        let known = false;
        const s = side(connection, (id) => {
          if (known) return;
          known = true;
          const link = links.get(id);
          if (link !== undefined) link.acceptor = s;
        });
      });
    };
    for (const name of NODES) await start(name);
    const ends: (() => void)[] = [];
    let next = 0;
    for (let step = 0; step < 400; step++) {
      const roll = chance();
      const live = [...links.entries()].filter(([, l]) => !l.dialer.closed);
      if (roll < 0.08 || live.length === 0) {
        const from = pick(NODES);
        const to = pick(NODES.filter((n) => n !== from));
        const t = transports.get(from);
        if (t === undefined) continue;
        const id = next++;
        const connection = t.connect(to);
        links.set(id, { dialer: side(connection), acceptor: undefined, nodes: [from, to] });
        // The first frame names the connection, so the acceptor's side can be found.
        const link = links.get(id);
        link?.dialer.sent.push(0);
        connection.send(`${String(id)}:0`);
      } else if (roll < 0.75) {
        const [id, link] = pick(live);
        const fromAcceptor = link.acceptor !== undefined && !link.acceptor.closed && chance() < 0.5;
        const s = fromAcceptor ? link.acceptor : link.dialer;
        if (s === undefined) continue;
        const seq = s.sent.length;
        s.sent.push(seq);
        s.connection.send(`${String(id)}:${String(seq)}`);
      } else if (roll < 0.8) {
        const [, link] = pick(live);
        (chance() < 0.5 || link.acceptor === undefined
          ? link.dialer
          : link.acceptor
        ).connection.close();
      } else if (roll < 0.85) {
        const a = NODES.filter(() => chance() < 0.5);
        const b = NODES.filter((n) => !a.includes(n));
        if (a.length > 0 && b.length > 0) {
          ends.push(network.partition(a, b, { oneWay: chance() < 0.3 }));
        }
      } else if (roll < 0.9) {
        pick(ends.splice(Math.floor(chance() * ends.length), 1).concat([() => undefined]))();
      } else if (roll < 0.93) {
        const [, link] = pick(live);
        network.reset(link.nodes[0] as string, link.nodes[1] as string);
      } else if (roll < 0.96) {
        ends.push(
          network.delay({ node: pick(NODES), latencyMs: [10, 10 + Math.floor(chance() * 300)] }),
        );
      } else if (roll < 0.98) {
        ends.push(network.reorder({ node: pick(NODES), windowMs: 1 + Math.floor(chance() * 50) }));
      } else {
        const victim = pick(NODES);
        network.kill(victim);
        for (const link of links.values()) {
          if (link.nodes[0] === victim) link.dialer.gone = true;
          if (link.nodes[1] === victim && link.acceptor !== undefined) link.acceptor.gone = true;
        }
        await start(victim);
      }
      run(Math.floor(chance() * 40));
    }
    for (const end of ends) end();
    run(10_000);
    return { links, counts: network.counts() };
  }

  /** Whether `got` is `sent` cut short, and if it's short, whether `receiver` was told. */
  function check(sent: readonly number[], got: readonly number[], receiver: Side): string[] {
    const problems: string[] = [];
    if (got.some((seq, i) => seq !== sent[i]) || got.length > sent.length) {
      problems.push(`got ${got.join(',')} of ${sent.join(',')}`);
    }
    if (got.length < sent.length && !receiver.closed && !receiver.gone) {
      problems.push(`got ${String(got.length)} of ${String(sent.length)} and is still open`);
    }
    return problems;
  }

  it('holds over 200 seeds', async () => {
    let delivered = 0;
    let held = 0;
    let timedOut = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const { links, counts } = await trial(seed);
      delivered += counts.delivered;
      held += counts.held;
      timedOut += counts.timedOut;
      for (const [id, link] of links) {
        const where = `seed ${String(seed)}, connection ${String(id)}`;
        if (link.acceptor === undefined) {
          // It never opened, or its first frame was lost with it: so was everything after.
          expect(link.dialer.closed || link.dialer.gone, where).toBe(true);
          continue;
        }
        expect(check(link.dialer.sent, link.acceptor.got, link.acceptor), where).toEqual([]);
        expect(check(link.acceptor.sent, link.dialer.got, link.dialer), where).toEqual([]);
      }
    }
    // The faults did happen.
    expect(delivered).toBeGreaterThan(5_000);
    expect(held).toBeGreaterThan(500);
    expect(timedOut).toBeGreaterThan(10);
  });

  it('can fail: chaos mode breaks it', async () => {
    let broken = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const { links } = await trial(seed, 'chaos');
      for (const link of links.values()) {
        if (link.acceptor === undefined) continue;
        if (check(link.dialer.sent, link.acceptor.got, link.acceptor).length > 0) broken++;
      }
    }
    expect(broken).toBeGreaterThan(0);
  });
});
