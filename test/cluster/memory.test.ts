import { describe, expect, it } from 'vitest';
import { inMemoryNetwork } from '../../src/cluster/memory.js';
import type { Connection } from '../../src/cluster/transport.js';
import { ManualScheduler } from '../../src/testkit/manual-scheduler.js';

// Milestone 4, T2: the in-memory network (decision 0026), on its own.

function setup(latencyMs = 5) {
  const scheduler = new ManualScheduler();
  const network = inMemoryNetwork({ scheduler, latencyMs });
  const run = (ms: number): void => {
    scheduler.advanceTo(scheduler.now() + ms);
  };
  return { scheduler, network, run };
}

/** Records what a connection sees. */
function record(connection: Connection) {
  const frames: string[] = [];
  const closes: unknown[] = [];
  connection.onFrame((frame) => frames.push(frame));
  connection.onClose((...args) => closes.push(args.length === 0 ? 'clean' : args[0]));
  return { frames, closes };
}

async function pair(latencyMs = 5) {
  const net = setup(latencyMs);
  const server = net.network.transport('b');
  const accepted: Connection[] = [];
  await server.listen((connection) => accepted.push(connection));
  const client = net.network.transport('a');
  return { ...net, server, client, accepted };
}

describe('inMemoryNetwork', () => {
  it('opens after the latency, and delivers frames in order, each after the latency', async () => {
    const { network, run, scheduler } = setup(5);
    const arrivals: number[] = [];
    const frames: string[] = [];
    const accepted: Connection[] = [];
    await network.transport('b').listen((connection) => {
      accepted.push(connection);
      connection.onFrame((frame) => {
        frames.push(frame);
        arrivals.push(scheduler.now());
      });
    });
    const out = network.transport('a').connect('b');
    for (let i = 0; i < 100; i++) out.send(String(i));
    run(4);
    expect(accepted).toHaveLength(0);
    run(1);
    // Sent at time 0, before it opened, they arrive just after the open, in order.
    expect(accepted).toHaveLength(1);
    expect(frames).toEqual(Array.from({ length: 100 }, (_, i) => String(i)));
    expect(new Set(arrivals)).toEqual(new Set([5]));
    const back = record(out);
    (accepted[0] as Connection).send('back');
    run(4);
    expect(back.frames).toEqual([]);
    run(1);
    expect(back.frames).toEqual(['back']);
  });

  it('closes a connection to an address nobody listens at, with an error', () => {
    const { network, run, scheduler } = setup(3);
    const out = network.transport('a').connect('nowhere');
    const seen = record(out);
    out.send('lost');
    run(3);
    scheduler.runReady();
    expect(seen.closes).toHaveLength(1);
    expect(String(seen.closes[0])).toContain('nothing listens at nowhere');
    // Telling a closed connection does nothing, and listeners added late still hear of it.
    out.send('dropped');
    const late: unknown[] = [];
    out.onClose(() => late.push('late'));
    scheduler.runReady();
    expect(late).toEqual(['late']);
  });

  it('delivers what was sent before a close, then closes the other end cleanly', async () => {
    const { client, accepted, run, scheduler } = await pair(2);
    const out = client.connect('b');
    run(2);
    const inbound = record(accepted[0] as Connection);
    const own = record(out);
    out.send('last');
    out.close();
    out.close();
    scheduler.runReady();
    expect(own.closes).toEqual(['clean']);
    run(2);
    scheduler.runReady();
    expect(inbound.frames).toEqual(['last']);
    expect(inbound.closes).toEqual(['clean']);
  });

  it('kill drops frames in flight both ways, tells the other end with an error, and frees the address', async () => {
    const { network, client, accepted, run, scheduler } = await pair(4);
    const out = client.connect('b');
    run(4);
    const inbound = accepted[0] as Connection;
    const serverSide = record(inbound);
    const clientSide = record(out);
    out.send('to b');
    inbound.send('to a');
    network.kill('b');
    network.kill('b');
    run(4);
    scheduler.runReady();
    expect(serverSide.frames).toEqual([]);
    expect(serverSide.closes).toEqual([]);
    expect(clientSide.frames).toEqual([]);
    expect(String(clientSide.closes[0])).toContain('the connection to b was reset');
    // Nobody listens at b now, and the address can be taken again.
    const refused = record(client.connect('b'));
    run(4);
    scheduler.runReady();
    expect(String(refused.closes[0])).toContain('nothing listens at b');
    const again = network.transport('b');
    await again.listen(() => {});
    expect(again.address).toBe('b');
  });

  it('close stops listening and ends every connection, and the address is free again', async () => {
    const { network, server, client, accepted, run, scheduler } = await pair(1);
    const out = record(client.connect('b'));
    run(1);
    expect(accepted).toHaveLength(1);
    await server.close();
    await server.close();
    run(1);
    scheduler.runReady();
    expect(out.closes).toEqual(['clean']);
    await expect(server.listen(() => {})).rejects.toThrow('has closed');
    const dead = record(server.connect('a'));
    scheduler.runReady();
    expect(String(dead.closes[0])).toContain('b has closed');
    expect(network.transport('b').address).toBe('b');
  });

  it('refuses a second live transport at one address, and a second listen', async () => {
    const { network } = setup();
    const t = network.transport('a');
    expect(() => network.transport('a')).toThrow('already has a live transport');
    await t.listen(() => {});
    await expect(t.listen(() => {})).rejects.toThrow('already listening');
  });

  it('checks its options and addresses where they are passed in', () => {
    const scheduler = new ManualScheduler();
    expect(() => inMemoryNetwork({ scheduler, latencyMs: -1 })).toThrow(TypeError);
    expect(() => inMemoryNetwork({ scheduler, latencyMs: 1.5 })).toThrow(TypeError);
    expect(() => inMemoryNetwork({ scheduler: {} as never })).toThrow('must be a Scheduler');
    expect(() => inMemoryNetwork({ scheduler, extra: 1 } as never)).toThrow('unknown option');
    expect(() => inMemoryNetwork(null as never)).toThrow(TypeError);
    const network = inMemoryNetwork({ scheduler, latencyMs: 0 });
    expect(() => network.transport('')).toThrow(TypeError);
    expect(() => network.transport(3 as never)).toThrow(TypeError);
    network.kill('nobody');
  });
});
