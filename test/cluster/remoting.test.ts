import { afterEach, describe, expect, it } from 'vitest';
import { actor } from '../../src/actor.js';
import { startRemoting, utf8Bytes, PROTOCOL } from '../../src/cluster/remoting.js';
import type { Connection, Transport } from '../../src/cluster/transport.js';
import { AskTimeoutError } from '../../src/errors.js';
import { hooksOf } from '../../src/internal.js';
import { createSystem } from '../../src/system.js';
import { createTestKit } from '../../src/testkit/kit.js';
import { TestProbe } from '../../src/testkit/probe.js';
import { seededRandom } from '../../src/testkit/random.js';
import type { ActorRef, AnyRef, SystemEvent } from '../../src/types.js';
import { createTestCluster, type TestCluster, type TestNode } from '../helpers/cluster.js';

// Milestone 4, T2: remoting on the in-memory network (decision 0026).

let open: TestCluster[] = [];
afterEach(async () => {
  for (const cluster of open) await cluster.shutdown();
  open = [];
});

async function cluster(opts: Parameters<typeof createTestCluster>[0] = {}): Promise<TestCluster> {
  const made = await createTestCluster(opts);
  open.push(made);
  return made;
}

/** A ref on `from` to the actor at `ref.path` on `to`, as a message from `to` would carry it. */
function remoteRef<M>(from: TestNode, to: TestNode, ref: ActorRef<M>): ActorRef<M> {
  return from.remoting.ref(to.remoting.codec.uri(ref.path)) as unknown as ActorRef<M>;
}

/** Records every message it gets. */
function collector(log: unknown[]) {
  return actor<unknown, null>({
    initial: null,
    receive: (s, msg) => {
      log.push(msg);
      return s;
    },
  });
}

type Ping = { readonly n: number; readonly replyTo: ActorRef<number> };
/** Replies to each ping with its number, doubled. */
const doubler = actor<Ping, null>({
  initial: null,
  receive: (s, msg) => {
    msg.replyTo.tell(msg.n * 2);
    return s;
  },
});

function deadLetters(node: TestNode) {
  return node.events.filter(
    (e): e is Extract<SystemEvent, { type: 'deadLetter' }> => e.type === 'deadLetter',
  );
}

function warnings(node: TestNode): string[] {
  return node.logs.filter((l) => l.level === 'warn').map((l) => l.msg);
}

/** Wraps a transport, recording which connection each frame was sent on. */
function tapped(transport: Transport) {
  const sent: { readonly connection: Connection; readonly frame: string }[] = [];
  const wrap = (connection: Connection): Connection => ({
    send: (frame) => {
      sent.push({ connection: wrapped.get(connection) ?? connection, frame });
      connection.send(frame);
    },
    onFrame: (l) => {
      connection.onFrame(l);
    },
    onClose: (l) => {
      connection.onClose(l);
    },
    close: () => {
      connection.close();
    },
  });
  const wrapped = new Map<Connection, Connection>();
  const make = (connection: Connection): Connection => {
    const w = wrap(connection);
    wrapped.set(connection, w);
    return w;
  };
  const dialed: Connection[] = [];
  const accepted: Connection[] = [];
  const tap: Transport = {
    address: transport.address,
    listen: (onConnection) =>
      transport.listen((c) => {
        const w = make(c);
        accepted.push(c);
        onConnection(w);
      }),
    connect: (address) => {
      const c = transport.connect(address);
      dialed.push(c);
      return make(c);
    },
    close: () => transport.close(),
  };
  return { tap, sent, dialed, accepted };
}

describe('tell across nodes', () => {
  it('arrives, and messages from one node to one actor arrive in send order', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'] });
    const [a, b] = [c.node(0), c.node(1)];
    const log: unknown[] = [];
    const target = a.system.spawn(collector(log), 'target');
    const remote = remoteRef(b, a, target);
    expect(remote.path).toBe(`troupe://test@node-1#${String(a.remoting.self.uid)}/user/target`);
    // Sent before there's a connection, so they wait for the handshake, then go in order.
    for (let i = 0; i < 1000; i++) remote.tell({ i });
    await c.advance(5);
    for (let i = 1000; i < 2000; i++) remote.tell({ i });
    await c.advance(5);
    expect(log).toEqual(Array.from({ length: 2000 }, (_, i) => ({ i })));
  });

  it('keeps send order from an actor too, with its tells interleaved across turns', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'], system: { throughput: 1 } });
    const [a, b] = [c.node(0), c.node(1)];
    const log: unknown[] = [];
    const target = remoteRef(b, a, a.system.spawn(collector(log), 'target'));
    const relay = b.system.spawn(
      actor<number, null>({
        initial: null,
        receive: (s, n) => {
          target.tell(n);
          return s;
        },
      }),
    );
    for (let i = 0; i < 50; i++) relay.tell(i);
    await c.advance(5);
    expect(log).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it('uses one connection per pair when both nodes dial at once: the one the lower address dialed', async () => {
    const c = await cluster({ addresses: [] });
    const t1 = tapped(c.network.transport('node-1'));
    const t2 = tapped(c.network.transport('node-2'));
    const make = (transport: Transport, seed: number) => {
      const handle = createSystem({ scheduler: c.scheduler, random: seededRandom(seed) });
      return {
        system: handle.system,
        remoting: startRemoting(handle.system, { cluster: 'test', transport }),
      };
    };
    const n1 = make(t1.tap, 1);
    const n2 = make(t2.tap, 2);
    await Promise.all([n1.remoting.whenListening, n2.remoting.whenListening]);
    const log1: unknown[] = [];
    const log2: unknown[] = [];
    const on1 = n1.system.spawn(collector(log1), 'x');
    const on2 = n2.system.spawn(collector(log2), 'x');
    const to2 = n1.remoting.ref(n2.remoting.codec.uri(on2.path));
    const to1 = n2.remoting.ref(n1.remoting.codec.uri(on1.path));
    for (let i = 0; i < 10; i++) {
      (to2 as ActorRef<number>).tell(i);
      (to1 as ActorRef<number>).tell(i);
    }
    await c.advance(50);
    expect(log1).toEqual(Array.from({ length: 10 }, (_, i) => i));
    expect(log2).toEqual(Array.from({ length: 10 }, (_, i) => i));
    expect(t1.dialed).toHaveLength(1);
    expect(t2.dialed).toHaveLength(1);
    // Every message went on node-1's dial: from node-1 as its outbound, from node-2 as its inbound.
    const msgs1 = t1.sent.filter((s) => s.frame.includes('"t":"msg"'));
    const msgs2 = t2.sent.filter((s) => s.frame.includes('"t":"msg"'));
    expect(new Set(msgs1.map((s) => s.connection)).size).toBe(1);
    expect(new Set(msgs2.map((s) => s.connection)).size).toBe(1);
    expect(msgs2[0]?.connection).not.toBe(
      t2.sent.find((s) => s.frame.includes('hello'))?.connection,
    );
    const done = [n1.system.terminate(), n2.system.terminate()];
    await c.settle();
    await Promise.all(done);
  });

  it('dead-letters a message to a stopped actor, or an old incarnation, on the receiving node', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'] });
    const [a, b] = [c.node(0), c.node(1)];
    const target = a.system.spawn(collector([]), 'target');
    const remote = remoteRef(b, a, target);
    a.system.stop(target);
    await c.settle();
    (remote as ActorRef<string>).tell('late');
    const old = b.remoting.ref(`troupe://test@node-1#${String(a.remoting.self.uid + 1)}/user/x`);
    (old as ActorRef<string>).tell('old');
    await c.advance(5);
    expect(deadLetters(a)).toEqual([
      expect.objectContaining({ recipient: '/user/target', message: 'late', reason: 'stopped' }),
      expect.objectContaining({ recipient: old.path, message: 'old', reason: 'stopped' }),
    ]);
  });
});

describe('ask across nodes', () => {
  it('resolves with the reply', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'] });
    const [a, b] = [c.node(0), c.node(1)];
    const remote = remoteRef(b, a, a.system.spawn(doubler, 'doubler'));
    const answer = remote.ask<number>((replyTo) => ({ n: 21, replyTo }));
    await c.advance(5);
    await expect(answer).resolves.toBe(42);
  });

  it('pipes on the scheduler: the reply frame and the piped message run in one task', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'] });
    const [a, b] = [c.node(0), c.node(1)];
    const remote = remoteRef(b, a, a.system.spawn(doubler, 'doubler'));
    const got: unknown[] = [];
    b.system.spawn(
      actor<{ readonly answer: unknown } | 'go', null>({
        initial: (ctx) => {
          ctx.self.tell('go');
          return null;
        },
        receive: (s, msg, ctx) => {
          if (msg === 'go') {
            ctx.pipeToSelf(
              remote.ask<number>((replyTo) => ({ n: 4, replyTo })),
              (result) => ({ answer: result.ok ? result.value : 'failed' }),
            );
          } else {
            got.push(msg.answer);
          }
          return s;
        },
      }),
    );
    // Only the scheduler runs here: no promise is awaited, so no microtask can finish the ask.
    c.scheduler.runReady();
    for (let next = c.scheduler.nextTimerAt(); got.length === 0 && next !== undefined;) {
      c.scheduler.advanceTo(next);
      c.scheduler.runReady();
      next = c.scheduler.nextTimerAt();
    }
    expect(got).toEqual([8]);
  });

  it('times out when the node it went to is killed', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'], system: { askTimeoutMs: 1000 } });
    const [a, b] = [c.node(0), c.node(1)];
    const remote = remoteRef(b, a, a.system.spawn(doubler, 'doubler'));
    await c.advance(5);
    c.kill(0);
    const answer = remote.ask<number>((replyTo) => ({ n: 1, replyTo }));
    const settled = expect(answer).rejects.toThrow(AskTimeoutError);
    await c.advance(999);
    let done = false;
    void answer.catch(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    await c.advance(1);
    await settled;
  });

  it('dead-letters a reply that comes after the ask has timed out', async () => {
    const c = await cluster({
      addresses: ['node-1', 'node-2'],
      latencyMs: 50,
      system: { askTimeoutMs: 60 },
    });
    const [a, b] = [c.node(0), c.node(1)];
    const remote = remoteRef(b, a, a.system.spawn(doubler, 'doubler'));
    const answer = remote.ask<number>((replyTo) => ({ n: 1, replyTo }));
    const failed = expect(answer).rejects.toThrow(AskTimeoutError);
    await c.advance(500);
    await failed;
    expect(deadLetters(b)).toContainEqual(
      expect.objectContaining({ message: 2, reason: 'askCompleted' }),
    );
  });
});

describe('refs in messages', () => {
  it('a reply carries a ref back, and a ref passed on to a third node reaches the right actor', async () => {
    const c = await cluster();
    const [a, b, n3] = [c.node(0), c.node(1), c.node(2)];
    const onA: unknown[] = [];
    const onB: unknown[] = [];
    const collectorA = a.system.spawn(collector(onA), 'inbox');
    const inboxB = b.system.spawn(collector(onB), 'inbox');
    type Hand = { readonly replyTo: ActorRef<AnyRef> };
    // On B: answers with a ref to B's inbox.
    const desk = b.system.spawn(
      actor<Hand, null>({
        initial: null,
        receive: (s, msg) => {
          msg.replyTo.tell(inboxB);
          return s;
        },
      }),
      'desk',
    );
    type Pass = { readonly to: ActorRef<string>; readonly text: string };
    // On the third node: tells whatever ref it's given.
    const relay = n3.system.spawn(
      actor<Pass, null>({
        initial: null,
        receive: (s, msg) => {
          msg.to.tell(msg.text);
          return s;
        },
      }),
      'relay',
    );
    const deskOnA = remoteRef(a, b, desk);
    const got = deskOnA.ask<AnyRef>((replyTo) => ({ replyTo }));
    await c.advance(10);
    const inboxOnA = (await got) as unknown as ActorRef<string>;
    expect(inboxOnA.path).toBe(b.remoting.codec.uri('/user/inbox'));
    inboxOnA.tell('from A');
    // A passes B's inbox and its own collector on to the third node, which uses both.
    const relayOnA = remoteRef(a, n3, relay);
    relayOnA.tell({ to: inboxOnA, text: 'via node-3' });
    relayOnA.tell({ to: collectorA, text: 'home again' });
    await c.advance(10);
    expect(onB).toEqual(['from A', 'via node-3']);
    expect(onA).toEqual(['home again']);
  });

  it('refuses a ref that is not a ref URI in this cluster', async () => {
    const c = await cluster({ addresses: ['node-1'] });
    expect(() => c.node(0).remoting.ref('nope')).toThrow(TypeError);
    expect(() => c.node(0).remoting.ref('troupe://other@node-2#1/user/x')).toThrow(
      'cluster "other"',
    );
  });
});

describe('what cannot be sent', () => {
  it('an unserializable message is a dead letter with a warning naming its path, never a throw', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'] });
    const [a, b] = [c.node(0), c.node(1)];
    const remote = remoteRef<unknown>(b, a, a.system.spawn(collector([]), 'target'));
    const message = { seats: new Map() };
    expect(() => {
      remote.tell(message);
    }).not.toThrow();
    expect(deadLetters(b)).toEqual([
      expect.objectContaining({ recipient: remote.path, message, reason: 'unserializable' }),
    ]);
    expect(warnings(b)[0]).toContain('$.seats');
    // A ref from another system isn't one this node can send either.
    const stranger = createTestKit().system.spawn(collector([]));
    remote.tell({ replyTo: stranger });
    expect(warnings(b)[1]).toContain('$.replyTo is a ref from another actor system');
  });

  it('a message over maxFrameBytes, counted in UTF-8 bytes, is unserializable', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'], remoting: { maxFrameBytes: 400 } });
    const [a, b] = [c.node(0), c.node(1)];
    const log: unknown[] = [];
    const remote = remoteRef(b, a, a.system.spawn(collector(log), 'target')) as ActorRef<string>;
    remote.tell('x'.repeat(200));
    // 200 characters, but 400 bytes: over the limit once the frame's header is added.
    remote.tell('é'.repeat(200));
    await c.advance(5);
    expect(log).toEqual(['x'.repeat(200)]);
    expect(deadLetters(b)).toEqual([expect.objectContaining({ reason: 'unserializable' })]);
    expect(warnings(b)[0]).toMatch(/over maxFrameBytes \(400\)/);
  });

  it('counts UTF-8 bytes as TextEncoder does', () => {
    const encoder = new TextEncoder();
    for (const text of ['', 'abc', 'é', '€', '😀', 'a😀b€é', '\ud800', '\udc00x', 'x\ud800']) {
      expect(utf8Bytes(text)).toBe(encoder.encode(text).length);
    }
  });

  it('frames for a killed node fill the buffer, then become unreachable dead letters', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'], remoting: { bufferSize: 3 } });
    const [a, b] = [c.node(0), c.node(1)];
    const remote = remoteRef(b, a, a.system.spawn(collector([]), 'target')) as ActorRef<number>;
    remote.tell(0);
    await c.advance(5);
    c.kill(0);
    await c.advance(5);
    for (let i = 1; i <= 5; i++) remote.tell(i);
    expect(deadLetters(b).map((d) => [d.message, d.reason])).toEqual([
      [4, 'unreachable'],
      [5, 'unreachable'],
    ]);
    // Remoting keeps dialing, with backoff, and the buffer keeps its messages meanwhile.
    await c.advance(30_000);
    expect(deadLetters(b)).toHaveLength(2);
    // Once membership says the node is down, they go too, and so does anything sent later.
    b.remoting.nodeDown('node-1');
    b.remoting.nodeDown('node-1');
    remote.tell(6);
    expect(deadLetters(b).map((d) => [d.message, d.reason])).toEqual([
      [4, 'unreachable'],
      [5, 'unreachable'],
      [1, 'unreachable'],
      [2, 'unreachable'],
      [3, 'unreachable'],
      [6, 'unreachable'],
    ]);
  });

  it('delivers what waited once a restarted node is back, to its new incarnation', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'] });
    const b = c.node(1);
    c.kill(0);
    const remote = b.remoting.ref('troupe://test@node-1#1/user/target') as ActorRef<number>;
    remote.tell(1);
    await c.advance(400);
    const a2 = await c.restart(0);
    const log: unknown[] = [];
    a2.system.spawn(collector(log), 'target');
    const fresh = remoteRef(b, a2, { path: '/user/target' } as ActorRef<number>);
    fresh.tell(2);
    await c.advance(10_000);
    // The old URI names another incarnation: a stopped dead letter on the new one.
    expect(log).toEqual([2]);
    expect(deadLetters(a2)).toContainEqual(
      expect.objectContaining({ recipient: remote.path, reason: 'stopped' }),
    );
  });

  it('after close, every tell is a terminated dead letter', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'] });
    const [a, b] = [c.node(0), c.node(1)];
    const remote = remoteRef(b, a, a.system.spawn(collector([]), 'target')) as ActorRef<number>;
    remote.tell(1);
    await b.remoting.close();
    remote.tell(2);
    expect(deadLetters(b).map((d) => [d.message, d.reason])).toEqual([
      [1, 'terminated'],
      [2, 'terminated'],
    ]);
  });
});

describe('reconnecting', () => {
  it('dials again with doubling, jittered backoff up to 5 s, and only while something waits', async () => {
    const c = await cluster({ addresses: [] });
    const t = tapped(c.network.transport('node-2'));
    const dials: number[] = [];
    const counted: Transport = {
      ...t.tap,
      connect: (address) => {
        dials.push(c.scheduler.now());
        return t.tap.connect(address);
      },
    };
    const handle = createSystem({ scheduler: c.scheduler, random: seededRandom(3) });
    const node = startRemoting(handle.system, { cluster: 'test', transport: counted });
    await node.whenListening;
    // Nobody listens at node-1, so every dial fails.
    (node.ref('troupe://test@node-1#1/user/x') as ActorRef<number>).tell(1);
    await c.advance(60_000);
    const gaps = dials.slice(1).map((at, i) => at - (dials[i] as number) - 1);
    expect(gaps.length).toBeGreaterThan(10);
    gaps.forEach((gap, i) => {
      const ceiling = Math.min(5_000, 100 * 2 ** i);
      expect(gap).toBeGreaterThanOrEqual(ceiling / 2);
      expect(gap).toBeLessThanOrEqual(ceiling);
    });
    // Jittered: not every gap is the ceiling.
    expect(new Set(gaps.slice(-5)).size).toBeGreaterThan(1);
    // Once it's down, it stops dialing.
    node.nodeDown('node-1');
    const before = dials.length;
    await c.advance(60_000);
    expect(dials).toHaveLength(before);
    const done = handle.system.terminate();
    await c.settle();
    await done;
  });
});

describe('the handshake', () => {
  it('refuses a node with another cluster name, and both sides log why', async () => {
    const c = await cluster({ addresses: ['node-1'] });
    const a = c.node(0);
    const log: unknown[] = [];
    a.system.spawn(collector(log), 'target');
    const kit = createSystem({
      scheduler: c.scheduler,
      random: seededRandom(9),
      logger: {
        debug: () => {},
        info: () => {},
        warn: (msg) => strangerLogs.push(msg),
        error: () => {},
      },
    });
    const strangerLogs: string[] = [];
    const stranger = startRemoting(kit.system, {
      cluster: 'other',
      transport: c.network.transport('stranger'),
    });
    const remote = stranger.ref(`troupe://other@node-1#${String(a.remoting.self.uid)}/user/target`);
    (remote as ActorRef<string>).tell('hello?');
    await c.advance(5);
    expect(log).toEqual([]);
    expect(warnings(a)).toContainEqual(
      'remoting: refused the connection with stranger: its cluster is "other", not "test"',
    );
    expect(strangerLogs).toContainEqual(
      'remoting: refused the connection with node-1: its cluster is "test", not "other"',
    );
    const done = kit.system.terminate();
    await c.settle();
    await done;
    await stranger.close();
  });

  it('refuses another protocol, a frame before the hello, and frames that are not frames', async () => {
    const c = await cluster({ addresses: ['node-1'] });
    const a = c.node(0);
    const hello = { t: 'hello', cluster: 'test', address: 'raw', uid: 1 };
    const raw = c.network.transport('raw');
    const attempts: [string, string][] = [
      [JSON.stringify({ ...hello, protocol: PROTOCOL + 1 }), 'its protocol is 2, not 1'],
      [JSON.stringify({ t: 'msg', to: 'x' }), 'it sent "msg" before its hello'],
      ['not json', "it sent a frame that isn't one"],
      [JSON.stringify({ ...hello, protocol: PROTOCOL, uid: -1 }), 'its uid is -1'],
      [JSON.stringify({ ...hello, protocol: PROTOCOL, address: 'a b' }), 'its address is "a b"'],
      [JSON.stringify({ ...hello, protocol: PROTOCOL, address: 'node-1' }), 'own address'],
    ];
    for (const [frame, why] of attempts) {
      const connection = raw.connect('node-1');
      const closed: string[] = [];
      connection.onClose(() => closed.push('closed'));
      connection.send(frame);
      await c.advance(5);
      expect(closed).toEqual(['closed']);
      expect(warnings(a).at(-1)).toContain(why);
    }
  });

  it('refuses a hello from a dialed node that says it is someone else', async () => {
    const c = await cluster({ addresses: ['node-1'] });
    const a = c.node(0);
    // An impostor at node-2 answers with node-3's name.
    await c.network.transport('node-2').listen((connection) => {
      connection.onFrame(() => {
        connection.send(
          JSON.stringify({
            t: 'hello',
            cluster: 'test',
            protocol: PROTOCOL,
            address: 'node-3',
            uid: 5,
          }),
        );
      });
    });
    (a.remoting.ref('troupe://test@node-2#5/user/x') as ActorRef<number>).tell(1);
    await c.advance(5);
    expect(warnings(a)).toContainEqual(
      "remoting: refused the connection with node-2: it says it's node-3, not node-2",
    );
  });

  it('ignores frames it does not know once connected, with a warning', async () => {
    const c = await cluster({ addresses: ['node-1'] });
    const a = c.node(0);
    const connection = c.network.transport('raw').connect('node-1');
    connection.send(
      JSON.stringify({ t: 'hello', cluster: 'test', protocol: PROTOCOL, address: 'raw', uid: 3 }),
    );
    connection.send(JSON.stringify({ t: 'gossip' }));
    connection.send(JSON.stringify({ t: 'msg', to: 'troupe://test@node-9#1/user/x', m: 1 }));
    connection.send(
      JSON.stringify({ t: 'msg', to: a.remoting.codec.uri('/user/x'), m: { $bad: 1 } }),
    );
    await c.advance(5);
    expect(warnings(a)).toEqual([
      'remoting: ignored a "gossip" frame from raw',
      'remoting: a message from raw has a bad recipient',
      expect.stringContaining('has an unknown marker "$bad"'),
    ]);
    expect(deadLetters(a)).toEqual([
      expect.objectContaining({ recipient: '/user/x', reason: 'unserializable' }),
    ]);
  });

  it('refuses the downed incarnation of a node, and takes a new one', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'] });
    const [a, b] = [c.node(0), c.node(1)];
    const log: unknown[] = [];
    const remote = remoteRef(b, a, a.system.spawn(collector(log), 'target')) as ActorRef<number>;
    remote.tell(1);
    await c.advance(5);
    a.remoting.nodeDown('node-2');
    await c.advance(5);
    // node-2 doesn't know, so it dials again with what it sends next, and is refused.
    remote.tell(2);
    await c.advance(500);
    expect(log).toEqual([1]);
    expect(warnings(a)).toContainEqual(
      expect.stringContaining('was downed, and can rejoin only as a new uid'),
    );
  });

  it('checks its options where they are passed in', () => {
    const kit = createTestKit();
    const transport = {
      address: 'a',
      listen: () => Promise.resolve(),
      connect: () => ({}),
      close: () => Promise.resolve(),
    } as unknown as Transport;
    expect(() => startRemoting(kit.system, { cluster: 'Bad', transport })).toThrow('cluster name');
    expect(() => startRemoting(kit.system, { cluster: 'ok', transport: {} as never })).toThrow(
      'must be a Transport',
    );
    expect(() => startRemoting(kit.system, { cluster: 'ok', transport, bufferSize: -1 })).toThrow(
      TypeError,
    );
    expect(() => startRemoting(kit.system, { cluster: 'ok', transport, maxFrameBytes: 0 })).toThrow(
      TypeError,
    );
    expect(() => startRemoting(kit.system, { cluster: 'ok', transport, x: 1 } as never)).toThrow(
      'unknown option',
    );
    startRemoting(kit.system, { cluster: 'ok', transport });
    expect(() => startRemoting(kit.system, { cluster: 'ok', transport })).toThrow(
      'already installed',
    );
  });
});

describe('remote death watch', () => {
  /** A watcher on `on` that records each terminated signal. */
  function watching(on: TestNode, log: string[]) {
    return on.system.spawn(
      actor<{ watch: AnyRef } | { unwatch: AnyRef }, null>({
        initial: null,
        receive: (s, msg, ctx) => {
          if ('watch' in msg) ctx.watch(msg.watch);
          else ctx.unwatch(msg.unwatch);
          return s;
        },
        onSignal: (s, signal) => {
          if (signal.type === 'terminated') {
            const failure = signal.failure;
            log.push(
              failure === undefined
                ? `stopped ${signal.ref.path}`
                : `failed ${signal.ref.path}: ${(failure as Error).name}: ${(failure as Error).message}`,
            );
          }
          return s;
        },
      }),
    );
  }

  const fragile = actor<'stop' | 'fail', null>({
    initial: null,
    receive: (s, msg, ctx) => {
      if (msg === 'fail') throw new RangeError('out of seats');
      ctx.stop();
      return s;
    },
  });

  it('gives terminated when the remote actor stops, and when it fails, with the failure', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'] });
    const [a, b] = [c.node(0), c.node(1)];
    const log: string[] = [];
    const w = watching(b, log);
    const calm = remoteRef(b, a, a.system.spawn(fragile, 'calm'));
    const wild = remoteRef(b, a, a.system.spawn(fragile, 'wild'));
    w.tell({ watch: calm });
    w.tell({ watch: wild });
    // Twice is the same as once.
    w.tell({ watch: calm });
    await c.advance(5);
    calm.tell('stop');
    wild.tell('fail');
    await c.advance(10);
    expect(log).toEqual([`stopped ${calm.path}`, `failed ${wild.path}: RangeError: out of seats`]);
  });

  it('gives terminated at once for an actor that has already stopped, and nothing after unwatch', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'] });
    const [a, b] = [c.node(0), c.node(1)];
    const log: string[] = [];
    const w = watching(b, log);
    const gone = a.system.spawn(fragile, 'gone');
    a.system.stop(gone);
    const kept = remoteRef(b, a, a.system.spawn(fragile, 'kept'));
    await c.settle();
    w.tell({ watch: remoteRef(b, a, gone) });
    w.tell({ watch: kept });
    await c.advance(5);
    w.tell({ unwatch: kept });
    await c.advance(5);
    kept.tell('stop');
    await c.advance(5);
    expect(log).toEqual([`stopped ${a.remoting.codec.uri('/user/gone')}`]);
  });

  it('gives terminated, saying the node is gone, when its node restarts with a new uid', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'] });
    const [a, b] = [c.node(0), c.node(1)];
    const log: string[] = [];
    const w = watching(b, log);
    const target = remoteRef(b, a, a.system.spawn(fragile, 'target'));
    w.tell({ watch: target });
    await c.advance(5);
    c.kill(0);
    await c.advance(5);
    // A kill alone says nothing: the node may be back.
    expect(log).toEqual([]);
    const a2 = await c.restart(0);
    // The new incarnation says hello with what it sends, and its new uid ends the watch.
    const inbox = b.system.spawn(collector([]), 'inbox');
    (remoteRef(a2, b, inbox) as ActorRef<string>).tell('hi');
    await c.advance(10);
    expect(log).toEqual([
      `failed ${target.path}: Error: node node-1 is gone: restarted as uid ${String(a2.remoting.self.uid)}`,
    ]);
    // Watching a ref to the old incarnation now ends at once.
    w.tell({ watch: target });
    await c.settle();
    expect(log).toHaveLength(2);
  });

  it('gives terminated, saying the node is gone, when its node is downed', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'] });
    const [a, b] = [c.node(0), c.node(1)];
    const log: string[] = [];
    const w = watching(b, log);
    const target = remoteRef(b, a, a.system.spawn(fragile, 'target'));
    w.tell({ watch: target });
    await c.advance(5);
    b.remoting.nodeDown('node-1');
    await c.settle();
    expect(log).toEqual([`failed ${target.path}: Error: node node-1 is gone: down`]);
    w.tell({ watch: target });
    await c.settle();
    expect(log[1]).toBe(`failed ${target.path}: Error: node node-1 is gone: down`);
  });

  it('drops the watches a node held once it restarts, so its new incarnation hears nothing', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'] });
    const [a, b] = [c.node(0), c.node(1)];
    const log: string[] = [];
    const w = watching(b, log);
    const target = a.system.spawn(fragile, 'target');
    w.tell({ watch: remoteRef(b, a, target) });
    await c.advance(5);
    c.kill(1);
    const b2 = await c.restart(1);
    (remoteRef(b2, a, a.system.spawn(collector([]), 'inbox')) as ActorRef<string>).tell('hi');
    await c.advance(10);
    target.tell('stop');
    await c.advance(10);
    // Had node-1 kept the old watch, it would tell the new node-2 of the stop, which logs it.
    expect(b2.logs.filter((l) => l.msg.includes('nothing here watches'))).toEqual([]);
    expect(log).toEqual([]);
  });

  it('works for probes too, and throws for a ref nothing can watch', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'] });
    const [a, b] = [c.node(0), c.node(1)];
    const target = remoteRef(b, a, a.system.spawn(fragile, 'target'));
    const probe = new TestProbe<never>('/temp/probe-w', 'probe-w', b.handle);
    probe.watch(target);
    await c.advance(5);
    target.tell('stop');
    await c.advance(5);
    probe.expectTerminated(target);
    // A temporary ask ref isn't an actor, here or anywhere: an entity ref (T6) won't be either.
    let temp: AnyRef | undefined;
    void remoteRef(b, a, a.system.spawn(doubler))
      .ask<number>((replyTo) => {
        temp = replyTo;
        return { n: 1, replyTo };
      })
      .catch(() => {});
    expect(() => {
      probe.watch(temp as AnyRef);
    }).toThrow(TypeError);
    const hooks = hooksOf(b.system);
    expect(hooks.watchTarget({})).toBeUndefined();
    expect(hooks.watchTarget(null)).toBeUndefined();
    await c.advance(5);
  });
});

describe('the sender', () => {
  it('delivered.from is the remote sender’s full path when the sender was known', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'], messages: true });
    const [a, b] = [c.node(0), c.node(1)];
    const target = remoteRef(b, a, a.system.spawn(collector([]), 'target')) as ActorRef<string>;
    const sender = b.system.spawn(
      actor<string, null>({
        initial: null,
        receive: (s, msg) => {
          target.tell(msg);
          return s;
        },
      }),
      'sender',
    );
    sender.tell('from an actor');
    await c.settle();
    target.tell('from outside');
    await c.advance(5);
    const delivered = a.events.filter(
      (e): e is Extract<SystemEvent, { type: 'delivered' }> =>
        e.type === 'delivered' && e.path === '/user/target',
    );
    expect(delivered.map((d) => [d.message, d.from])).toEqual([
      ['from an actor', b.remoting.codec.uri('/user/sender')],
      ['from outside', undefined],
    ]);
  });
});

describe('determinism', () => {
  async function run(seed: number): Promise<string[][]> {
    const c = await createTestCluster({ seed, messages: true, system: { askTimeoutMs: 500 } });
    const nodes = c.nodes;
    const doublers = nodes.map((n) => n.system.spawn(doubler, 'doubler'));
    // Each node's asker pings the next node's doubler, and pipes the answers back to itself.
    nodes.forEach((n, i) => {
      const next = nodes[(i + 1) % nodes.length] as TestNode;
      const remote = remoteRef(n, next, doublers[(i + 1) % nodes.length] as ActorRef<Ping>);
      n.system.spawn(
        actor<number | { readonly got: unknown }, number>({
          initial: (ctx) => {
            ctx.timers.startPeriodic('tick', 0, 100);
            return 0;
          },
          receive: (count, msg, ctx) => {
            if (typeof msg !== 'number') return count;
            ctx.pipeToSelf(
              remote.ask<number>((replyTo) => ({ n: count, replyTo })),
              (result) => ({ got: result.ok ? result.value : 'timeout' }),
            );
            return count + 1;
          },
        }),
        'asker',
      );
    });
    await c.advance(1_000);
    c.kill(2);
    await c.advance(2_000);
    await c.restart(2);
    await c.advance(1_000);
    // Every incarnation's, the killed one's included.
    const out = c.incarnations.map((n) => n.events.map(show));
    await c.shutdown();
    return out;
  }

  it('two runs of three nodes with the same seed give identical events on every node', async () => {
    const first = await run(42);
    const second = await run(42);
    expect(first.map((e) => e.length)).toHaveLength(4);
    expect(first.every((e) => e.length > 20)).toBe(true);
    expect(second).toEqual(first);
    const other = await run(43);
    expect(other).not.toEqual(first);
  });
});

/** An event as text, with refs as their paths and errors as their messages. */
function show(event: SystemEvent): string {
  return JSON.stringify(event, (_key, value: unknown) => {
    if (typeof value === 'function') return undefined;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    return value;
  });
}
