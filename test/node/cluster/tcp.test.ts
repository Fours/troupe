import { createHmac, randomBytes } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { actor } from '../../../src/actor.js';
import { startRemoting } from '../../../src/cluster/remoting.js';
import type { Connection, Transport } from '../../../src/cluster/transport.js';
import { encodeFrame, FrameDecoder } from '../../../src/node/cluster/frames.js';
import {
  openTcpTransport,
  parseAddress,
  tcpTransport,
  type TcpNode,
  type TcpTransportOptions,
} from '../../../src/node/cluster/tcp.js';
import { createSystem } from '../../../src/system.js';
import { ManualScheduler } from '../../../src/testkit/manual-scheduler.js';
import { seededRandom } from '../../../src/testkit/random.js';
import type { ActorRef } from '../../../src/types.js';
import { freePort } from '../../helpers/tcp-network.js';

// Milestone 4, T3: the TCP transport (decision 0027). The remoting suite runs on it too, in
// remoting.test.ts. These are the transport's own: framing on real sockets, the proof of the
// secret, checked on the raw bytes, reconnecting, and closing.

const SECRET = 'correct horse battery staple';

let cleanups: (() => Promise<unknown> | undefined)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function open(
  opts: Partial<TcpTransportOptions> = {},
  internal?: { authTimeoutMs?: number },
): Promise<TcpNode> {
  const node = openTcpTransport({ port: await freePort(), secret: SECRET, ...opts }, internal);
  cleanups.push(() => node.transport.close());
  return node;
}

/** Waits for `condition`, letting real I/O run, for up to 5 s. */
async function until(condition: () => boolean, what = 'condition'): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`until: ${what} never held`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Everything a connection says: its frames, and how it closed. */
function watch(connection: Connection) {
  const frames: string[] = [];
  connection.onFrame((frame) => frames.push(frame));
  const closed = new Promise<unknown>((resolve) => {
    connection.onClose(resolve);
  });
  return { frames, closed };
}

/** Listens, keeping what it accepts and what it refuses. */
async function listening(node: TcpNode) {
  const accepted: ReturnType<typeof watch>[] = [];
  const refused: string[] = [];
  await node.transport.listen(
    (connection) => accepted.push(watch(connection)),
    (reason) => refused.push(reason),
  );
  return { accepted, refused };
}

/** A socket that speaks the frame format with no transport, recording every byte it's sent. */
function raw(socket: Socket) {
  const bytes: Buffer[] = [];
  const frames: Record<string, unknown>[] = [];
  const decoder = new FrameDecoder(10_000_000);
  socket.on('data', (chunk: Buffer) => {
    bytes.push(chunk);
    decoder.push(chunk);
    for (let next = decoder.next(); next?.frame !== undefined; next = decoder.next()) {
      frames.push(JSON.parse(next.frame) as Record<string, unknown>);
    }
  });
  socket.on('error', () => {});
  const closed = new Promise<void>((resolve) =>
    socket.once('close', () => {
      resolve();
    }),
  );
  return {
    socket,
    bytes,
    frames,
    closed,
    send: (frame: unknown) => socket.write(encodeFrame(JSON.stringify(frame))),
  };
}

async function rawClient(port: number) {
  const socket = connect(port, '127.0.0.1');
  await new Promise<void>((resolve) =>
    socket.once('connect', () => {
      resolve();
    }),
  );
  const client = raw(socket);
  cleanups.push(() => {
    socket.destroy();
    return client.closed;
  });
  return client;
}

/** A server that hands each raw socket to `onSocket`. */
async function rawServer(onSocket: (peer: ReturnType<typeof raw>) => void): Promise<Server> {
  const server = createServer((socket) => {
    onSocket(raw(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

function portOf(server: Server): number {
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('not listening');
  return address.port;
}

const nonce = () => randomBytes(32).toString('hex');
const mac = (secret: string, role: string, dialer: string, acceptor: string) =>
  createHmac('sha256', secret).update(`troupe-tcp/1 ${role} ${dialer} ${acceptor}`).digest('hex');

/** Whether the secret appears in `bytes` in any form a careless encoding would give it. */
function containsSecret(bytes: readonly Buffer[]): boolean {
  const all = Buffer.concat(bytes);
  const text = all.toString('latin1');
  const forms = [
    SECRET,
    Buffer.from(SECRET).toString('hex'),
    Buffer.from(SECRET).toString('base64'),
  ];
  return forms.some((form) => text.includes(form)) || all.includes(Buffer.from(SECRET));
}

describe('frames on TCP', () => {
  it('carry text both ways in order, including frames sent before the connection opened', async () => {
    const a = await open();
    const b = await open();
    const atA = await listening(a);
    const toA = b.transport.connect(a.transport.address);
    const fromA = watch(toA);
    const sent = [...Array.from({ length: 200 }, (_, i) => `m${String(i)}`), 'é€😀', ''];
    for (const frame of sent) toA.send(frame);
    await until(() => atA.accepted.length === 1, 'accepted');
    const accepted = atA.accepted[0] as ReturnType<typeof watch>;
    await until(() => accepted.frames.length === sent.length, 'frames at a');
    expect(accepted.frames).toEqual(sent);
    expect(atA.refused).toEqual([]);
    // And back the other way, on the accepted end.
    const [end] = [...a.connections];
    end?.send('welcome');
    await until(() => fromA.frames.length === 1, 'frames at b');
    expect(fromA.frames).toEqual(['welcome']);
  });

  it('close a connection whose peer sends a frame over the limit, after the frames before it', async () => {
    const a = await open({ maxFrameBytes: 100 });
    const b = await open();
    const atA = await listening(a);
    await listening(b);
    const toA = b.transport.connect(a.transport.address);
    const fromA = watch(toA);
    toA.send('x'.repeat(100));
    toA.send('x'.repeat(101));
    toA.send('after');
    await until(() => atA.refused.length === 1, 'refusal');
    const accepted = atA.accepted[0] as ReturnType<typeof watch>;
    expect(accepted.frames).toEqual(['x'.repeat(100)]);
    expect(atA.refused[0]).toMatch(/it sent a frame of 101 bytes, over the limit \(100\)$/);
    expect(await accepted.closed).toBeInstanceOf(Error);
    await fromA.closed;
    expect(a.connections.size).toBe(0);
  });
});

describe('proving the secret', () => {
  it('raises the frame limit at the proof, even for frames in the same chunk as it', async () => {
    const a = await open({ maxFrameBytes: 1_000 });
    const atA = await listening(a);
    const port = parseAddress(a.transport.address)?.port as number;
    /** A raw peer that knows the secret, and sends its proof and `frames` in one write. */
    const prove = async (frames: readonly string[]) => {
      const client = await rawClient(port);
      const mine = nonce();
      client.send({ t: 'challenge', protocol: 'troupe-tcp/1', nonce: mine });
      await until(() => client.frames.length === 2, 'challenge and proof');
      const theirs = client.frames[0]?.nonce as string;
      const proof = JSON.stringify({ t: 'proof', mac: mac(SECRET, 'dialer', mine, theirs) });
      client.socket.write(Buffer.concat([proof, ...frames].map(encodeFrame)));
      return client;
    };
    // Over the 256 bytes allowed before the proof, but within the limit after it.
    await prove(['x'.repeat(1_000)]);
    await until(() => atA.accepted[0]?.frames.length === 1, 'the big frame');
    expect(atA.accepted[0]?.frames).toEqual(['x'.repeat(1_000)]);
    // Over the limit after the proof, in the same write.
    const client = await prove(['ok', 'x'.repeat(1_001)]);
    await client.closed;
    expect(atA.accepted[1]?.frames).toEqual(['ok']);
    expect(atA.refused).toEqual([
      expect.stringContaining('it sent a frame of 1001 bytes, over the limit (1000)'),
    ]);
  });

  it('disconnects a peer with the wrong secret before any other frame, on both sides', async () => {
    const a = await open();
    const b = await open({ secret: 'wrong' });
    const atA = await listening(a);
    const atB = await listening(b);
    const toA = b.transport.connect(a.transport.address);
    const fromA = watch(toA);
    toA.send('secret plans');
    const error = (await fromA.closed) as Error;
    expect(error.message).toBe(
      `refused the TCP connection with ${a.transport.address}: it failed to prove the secret`,
    );
    await until(() => atA.refused.length === 1, 'refusal at a');
    expect(atA.refused[0]).toMatch(
      /^refused the TCP connection with 127\.0\.0\.1:\d+: it failed to prove the secret$/,
    );
    expect(atB.refused).toEqual([error.message]);
    expect(atA.accepted).toEqual([]);
    expect(fromA.frames).toEqual([]);
  });

  it('sends only a challenge and a proof to a peer that has not proven it, and never the secret', async () => {
    // A raw peer dials the transport: it gets the challenge and a proof, then a bogus proof of
    // its own is refused.
    const a = await open();
    const atA = await listening(a);
    const port = parseAddress(a.transport.address)?.port as number;
    const client = await rawClient(port);
    const mine = nonce();
    client.send({ t: 'challenge', protocol: 'troupe-tcp/1', nonce: mine });
    await until(() => client.frames.length === 2, 'challenge and proof');
    client.send({ t: 'proof', mac: '00'.repeat(32) });
    await client.closed;
    const [challenge, proof] = client.frames as [Record<string, string>, Record<string, string>];
    const hex: unknown = expect.stringMatching(/^[0-9a-f]{64}$/);
    expect(client.frames).toEqual([
      { t: 'challenge', protocol: 'troupe-tcp/1', nonce: hex },
      { t: 'proof', mac: hex },
    ]);
    // The proof is an HMAC of both nonces and the role: only the secret makes it.
    expect(proof.mac).toBe(mac(SECRET, 'acceptor', mine, challenge.nonce as string));
    expect(containsSecret(client.bytes)).toBe(false);
    expect(atA.accepted).toEqual([]);
    expect(atA.refused).toEqual([expect.stringContaining('it failed to prove the secret')]);

    // And the other way: the transport dials a raw peer, with a frame waiting to go.
    const heard: ReturnType<typeof raw>[] = [];
    const server = await rawServer((peer) => {
      heard.push(peer);
      peer.send({ t: 'challenge', protocol: 'troupe-tcp/1', nonce: nonce() });
    });
    const b = await open();
    const atB = await listening(b);
    const dialed = b.transport.connect(`127.0.0.1:${String(portOf(server))}`);
    const out = watch(dialed);
    dialed.send('precious');
    await until(() => heard[0]?.frames.length === 2, 'challenge and proof from b');
    const peer = heard[0] as ReturnType<typeof raw>;
    peer.send({ t: 'proof', mac: '00'.repeat(32) });
    expect(await out.closed).toBeInstanceOf(Error);
    await peer.closed;
    expect(peer.frames.map((f) => f.t)).toEqual(['challenge', 'proof']);
    expect(Buffer.concat(peer.bytes).includes('precious')).toBe(false);
    expect(containsSecret(peer.bytes)).toBe(false);
    expect(atB.refused).toEqual([expect.stringContaining('it failed to prove the secret')]);
  });

  it('refuses a reflected challenge, and a reflected proof', async () => {
    const a = await open();
    const atA = await listening(a);
    const port = parseAddress(a.transport.address)?.port as number;
    // Its own challenge sent back to it.
    const echo = await rawClient(port);
    await until(() => echo.frames.length === 1, 'challenge');
    echo.send({ t: 'challenge', protocol: 'troupe-tcp/1', nonce: echo.frames[0]?.nonce });
    await echo.closed;
    // Its own proof sent back to it: the role in the MAC tells them apart.
    const mirror = await rawClient(port);
    mirror.send({ t: 'challenge', protocol: 'troupe-tcp/1', nonce: nonce() });
    await until(() => mirror.frames.length === 2, 'proof');
    mirror.send(mirror.frames[1]);
    await mirror.closed;
    expect(atA.refused).toEqual([
      expect.stringContaining('it sent back our own challenge'),
      expect.stringContaining('it failed to prove the secret'),
    ]);
    expect(atA.accepted).toEqual([]);
  });

  it('refuses anything else before the proof: other frames, other protocols, big frames, silence', async () => {
    const a = await open({}, { authTimeoutMs: 50 });
    const atA = await listening(a);
    const port = parseAddress(a.transport.address)?.port as number;
    const attempts: [unknown, string][] = [
      [{ t: 'msg', m: 1 }, 'it sent something other than a challenge first'],
      [
        { t: 'challenge', protocol: 'troupe-tcp/2', nonce: nonce() },
        'its protocol is "troupe-tcp/2"',
      ],
      [{ t: 'challenge', protocol: 'troupe-tcp/1', nonce: 'abc' }, 'its challenge is malformed'],
      [{ t: 'challenge', protocol: 'troupe-tcp/1', x: 'y'.repeat(300) }, 'over the limit (256)'],
    ];
    for (const [frame, why] of attempts) {
      const client = await rawClient(port);
      client.send(frame);
      await client.closed;
      expect(atA.refused.at(-1)).toContain(why);
    }
    // A challenge, then something other than a proof.
    const chatty = await rawClient(port);
    chatty.send({ t: 'challenge', protocol: 'troupe-tcp/1', nonce: nonce() });
    chatty.send({ t: 'msg', m: 1 });
    await chatty.closed;
    expect(atA.refused.at(-1)).toContain('something other than a proof after its challenge');
    // A peer that says nothing is dropped when the proof's time is up: the socket's own timer.
    const silent = await rawClient(port);
    await silent.closed;
    expect(atA.refused.at(-1)).toContain("it didn't prove the secret within 50 ms");
    expect(atA.accepted).toEqual([]);
  });
});

describe('reconnecting', () => {
  it('a dropped connection is dialed again with backoff, and what was sent meanwhile arrives in order', async () => {
    const scheduler = new ManualScheduler();
    // node-2 reaches node-1 through a proxy that can cut the connection and refuse dials.
    const n1Port = await freePort();
    const proxied: Socket[] = [];
    let refuse = 0;
    const proxy = await rawServer(({ socket }) => {
      if (refuse > 0) {
        refuse--;
        socket.destroy();
        return;
      }
      const upstream = connect(n1Port, '127.0.0.1');
      upstream.on('error', () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
      proxied.push(socket, upstream);
    });
    // node-1 advertises the proxy's address, as a node in Docker advertises its service name.
    const n1 = await open({ port: n1Port, advertise: `127.0.0.1:${String(portOf(proxy))}` });
    const n2 = await open();
    const dials: number[] = [];
    const closes: number[] = [];
    const counted: Transport = {
      ...n2.transport,
      connect: (address) => {
        dials.push(scheduler.now());
        const connection = n2.transport.connect(address);
        connection.onClose(() => closes.push(scheduler.now()));
        return connection;
      },
    };
    const start = (transport: Transport, seed: number) => {
      const handle = createSystem({ scheduler, random: seededRandom(seed) });
      const remoting = startRemoting(handle.system, { cluster: 'test', transport });
      cleanups.push(async () => {
        const done = handle.system.terminate();
        scheduler.runReady();
        await done;
      });
      return { system: handle.system, remoting };
    };
    const node1 = start(n1.transport, 1);
    const node2 = start(counted, 2);
    await Promise.all([node1.remoting.whenListening, node2.remoting.whenListening]);
    const log: number[] = [];
    const target = node1.system.spawn(
      actor<number, null>({
        initial: null,
        receive: (s, n) => {
          log.push(n);
          return s;
        },
      }),
      'target',
    );
    const remote = node2.remoting.ref(node1.remoting.codec.uri(target.path)) as ActorRef<number>;

    /** Runs the scheduler and the network until `condition`, firing timers only while no dial is under way. */
    const drive = async (condition: () => boolean, what: string): Promise<void> => {
      const deadline = performance.now() + 5_000;
      for (;;) {
        scheduler.runReady();
        if (condition()) return;
        if (performance.now() > deadline) throw new Error(`drive: ${what} never held`);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const dialing = [...n2.connections].some((c) => c.state !== 'open');
        const next = scheduler.nextTimerAt();
        // Only the backoffs, at most 200 ms off: remoting's 5 s wait for a hello must never fire
        // while a real hello is on its way.
        if (!dialing && next !== undefined && next - scheduler.now() <= 1_000) {
          scheduler.advanceTo(next);
        }
      }
    };

    remote.tell(0);
    await drive(() => log.length === 1, 'the first message');
    expect(dials).toHaveLength(1);
    // The connection drops, and the next two dials are refused.
    refuse = 2;
    for (const socket of proxied) socket.resetAndDestroy();
    await until(() => n2.connections.size === 0, 'the drop noticed');
    for (let i = 1; i <= 50; i++) remote.tell(i);
    await drive(() => log.length === 51, 'the rest');
    expect(log).toEqual(Array.from({ length: 51 }, (_, i) => i));
    // A dial at once, then two more, each after its backoff: 50-100 ms, then 100-200 ms.
    expect(dials).toHaveLength(4);
    const gaps = [2, 3].map((i) => (dials[i] as number) - (closes[i - 1] as number));
    expect(gaps[0]).toBeGreaterThanOrEqual(50);
    expect(gaps[0]).toBeLessThanOrEqual(100);
    expect(gaps[1]).toBeGreaterThanOrEqual(100);
    expect(gaps[1]).toBeLessThanOrEqual(200);
  });
});

describe('the transport', () => {
  it('binds 127.0.0.1 by default, and is reached at host:port or what it advertises', async () => {
    const a = await open();
    await listening(a);
    const port = parseAddress(a.transport.address)?.port as number;
    expect(a.transport.address).toBe(`127.0.0.1:${String(port)}`);
    expect(a.bound()).toMatchObject({ address: '127.0.0.1', family: 'IPv4', port });
    expect(tcpTransport({ port, secret: SECRET, advertise: 'node-1:2552' }).address).toBe(
      'node-1:2552',
    );
    expect(tcpTransport({ port, secret: SECRET, host: '::1' }).address).toBe(
      `[::1]:${String(port)}`,
    );
    expect(parseAddress('[::1]:2552')).toEqual({ host: '::1', port: 2552 });
    expect(parseAddress('node-1:2552')).toEqual({ host: 'node-1', port: 2552 });
    for (const bad of ['node-1', 'node-1:0', 'node-1:65536', ':2552', 'a b:1', '[::1]']) {
      expect(parseAddress(bad), bad).toBeUndefined();
    }
  });

  it('close() ends every connection, both ways, and refuses what comes after', async () => {
    const a = await open();
    const b = await open();
    await listening(a);
    const atB = await listening(b);
    const out = a.transport.connect(b.transport.address);
    const inbound = b.transport.connect(a.transport.address);
    const outWatch = watch(out);
    const inWatch = watch(inbound);
    out.send('hi');
    inbound.send('hi');
    await until(() => atB.accepted.length === 1 && a.connections.size === 2, 'both open');
    const accepted = atB.accepted[0] as ReturnType<typeof watch>;
    await until(() => accepted.frames.length === 1, 'the frame');
    await a.transport.close();
    expect(a.connections.size).toBe(0);
    // The other ends hear of it.
    await Promise.all([inWatch.closed, accepted.closed, outWatch.closed]);
    out.send('dropped, without a throw');
    // Nothing listens there now.
    const late = watch(b.transport.connect(a.transport.address));
    expect(String(await late.closed)).toContain('ECONNREFUSED');
    // Closing again is fine, and a closed transport neither listens nor dials.
    await a.transport.close();
    await expect(a.transport.listen(() => {})).rejects.toThrow('has closed');
    const after = a.transport.connect(b.transport.address);
    after.send('dropped');
    expect(String(await watch(after).closed)).toContain('has closed');
  });

  it('kill() resets every connection: the other end sees an error, and nothing here is told', async () => {
    const a = await open();
    const b = await open();
    await listening(a);
    const toA = b.transport.connect(a.transport.address);
    const fromA = watch(toA);
    toA.send('hi');
    await until(() => [...a.connections].some((c) => c.received === 3), 'the frame');
    const [end] = [...a.connections];
    const here: unknown[] = [];
    end?.onClose((e) => here.push(e));
    a.kill();
    a.kill();
    // ECONNRESET, or EPIPE if this end was writing when the reset came.
    expect(String(await fromA.closed)).toMatch(/ECONNRESET|EPIPE/);
    expect(here).toEqual([]);
    expect(a.connections.size).toBe(0);
  });

  it('closes a dial it cannot make with an error, even for a listener that comes late', async () => {
    const a = await open();
    const nowhere = a.transport.connect('nope');
    nowhere.send('dropped');
    expect(String(await watch(nowhere).closed)).toContain('"nope" isn\'t host:port');
    // Told again, on a later turn, to a listener added after it closed.
    const late = await new Promise<unknown>((resolve) => {
      nowhere.onClose(resolve);
    });
    expect(String(late)).toContain("isn't host:port");
    // A clean close is told late too, with no error.
    const b = await open();
    await listening(b);
    const toB = a.transport.connect(b.transport.address);
    toB.send('hi');
    await until(() => b.connections.size === 1, 'open');
    toB.close();
    toB.close();
    expect(await watch(toB).closed).toBeUndefined();
  });

  it('refuses to listen twice, or on a port that is taken', async () => {
    const a = await open();
    await listening(a);
    await expect(a.transport.listen(() => {})).rejects.toThrow('already listening');
    const port = parseAddress(a.transport.address)?.port as number;
    const b = openTcpTransport({ port, secret: SECRET });
    await expect(b.transport.listen(() => {})).rejects.toThrow('EADDRINUSE');
    await b.transport.close();
  });

  it('checks its options where they are passed in', () => {
    const ok = { port: 2552, secret: SECRET };
    expect(() => tcpTransport({ ...ok, x: 1 } as never)).toThrow('unknown option "x"');
    expect(() => tcpTransport({ ...ok, port: 0 })).toThrow('port must be a positive integer');
    expect(() => tcpTransport({ ...ok, port: 1.5 })).toThrow('port must be a positive integer');
    expect(() => tcpTransport({ ...ok, port: 65_536 })).toThrow('at most 65535');
    expect(() => tcpTransport({ ...ok, host: '' })).toThrow('host must be');
    expect(() => tcpTransport({ ...ok, advertise: 'node-1' })).toThrow('advertise must be');
    expect(() => tcpTransport({ ...ok, secret: '' })).toThrow('secret must be');
    expect(() => tcpTransport({ ...ok, maxFrameBytes: 0 })).toThrow('maxFrameBytes');
    expect(() => tcpTransport(null as never)).toThrow('options must be an object');
  });
});
