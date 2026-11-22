import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { actor } from '../../src/actor.js';
import { backstage } from '../../src/backstage/source.js';
import type { BackstageSource, Frame, WireEvent } from '../../src/backstage/types.js';
import { inspectSystem } from '../../src/internal.js';
import {
  BATCH_MS,
  hostCheck,
  MAX_BODY,
  serve,
  serveBackstage,
  type BackstageServer,
} from '../../src/node/backstage/server.js';
import { createTestKit, type TestKit } from '../../src/testkit/kit.js';

const idle = actor<string, number>({ initial: 0, receive: (n) => n + 1 });

let dir: string;
let uiDir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'troupe-backstage-'));
  uiDir = join(dir, 'ui');
  mkdirSync(join(uiDir, 'assets'), { recursive: true });
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>Backstage</title>');
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log("ui")');
  // Beside the UI's folder, where no request may reach.
  writeFileSync(join(dir, 'secret.txt'), 'secret');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Everything a test opened, closed after it whether it passed or not.
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Served {
  readonly kit: TestKit;
  readonly server: BackstageServer;
  readonly port: number;
  /** The source's close, spied on. */
  readonly closeSource: ReturnType<typeof vi.fn>;
}

/** A server on a free port for a testkit system, its source's close spied on. */
async function start(opts: { maxBuffered?: number } = {}): Promise<Served> {
  const kit = createTestKit({ system: { name: 'stage' } });
  cleanups.push(() => kit.shutdown());
  const real = backstage(kit.system);
  const closeSource = vi.fn(() => {
    real.close();
  });
  const source: BackstageSource = { ...real, close: closeSource };
  const { log } = inspectSystem(kit.system);
  const server = await serve({
    source,
    scheduler: kit.scheduler,
    log,
    port: 0,
    host: '127.0.0.1',
    uiDir,
    ...opts,
  });
  cleanups.push(() => server.close());
  return { kit, server, port: Number(new URL(server.url).port), closeSource };
}

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** One HTTP request, with full control of its headers, Host included. */
function call(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          done({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on('error', fail);
    req.end(opts.body);
  });
}

const post = (port: number, body: string, type = 'application/json') =>
  call(port, '/request', { method: 'POST', headers: { 'Content-Type': type }, body });

/** An open `/events` stream, read message by message. */
interface EventStream {
  readonly res: IncomingMessage;
  /** Every `data:` message so far, each an array of frames. */
  readonly messages: Frame[][];
  /** The next message, waiting for it if it hasn't come. */
  next(): Promise<Frame[]>;
  /** Resolves when the server ends the stream or drops it. */
  readonly ended: Promise<void>;
  close(): void;
}

function openStream(port: number, headers: Record<string, string> = {}): Promise<EventStream> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path: '/events', headers }, (res) => {
      const messages: Frame[][] = [];
      let read = 0;
      let waiting: (() => void) | undefined;
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice('data: '.length));
          if (data.length > 0) messages.push(JSON.parse(data.join('\n')) as Frame[]);
        }
        waiting?.();
      });
      const ended = new Promise<void>((resolve) => {
        res.on('close', resolve);
      });
      const next = async (): Promise<Frame[]> => {
        while (messages.length <= read) {
          await new Promise<void>((resolve) => (waiting = resolve));
        }
        return messages[read++] as Frame[];
      };
      done({
        res,
        messages,
        next,
        ended,
        close: () => {
          req.destroy();
        },
      });
    });
    req.on('error', fail);
    req.end();
  });
}

const events = (frames: readonly Frame[]): WireEvent[] =>
  frames.flatMap((f) => (f.type === 'event' ? [f.event] : []));

const hello = (frames: readonly Frame[]) => {
  const [first] = frames;
  if (frames.length !== 1 || first?.type !== 'hello') throw new Error('expected a lone hello');
  return first;
};

/** Gives the network a round trip, so anything already written has arrived. */
const roundTrip = (port: number) => call(port, '/missing');

const corsHeaders = (reply: { headers: IncomingHttpHeaders }) =>
  Object.keys(reply.headers).filter((name) => name.startsWith('access-control-'));

describe('serveBackstage: the UI', () => {
  it('serves index.html at / with a CSP, and the UI’s files by path', async () => {
    const { port } = await start();
    const index = await call(port, '/');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.headers['content-security-policy']).toContain("default-src 'self'");
    expect(index.headers['x-content-type-options']).toBe('nosniff');
    expect(index.body).toContain('<title>Backstage</title>');

    const script = await call(port, '/assets/app.js?v=1');
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.body).toBe('console.log("ui")');
  });

  it('serves nothing outside the UI’s folder, and 404s what isn’t there', async () => {
    const { port } = await start();
    for (const path of [
      '/..%2Fsecret.txt',
      '/assets/..%2F..%2Fsecret.txt',
      '/%2e%2e/secret.txt',
      '/missing.js',
      '/assets',
      '/%E0%A4%A',
      '/index.html%00.js',
    ]) {
      const reply = await call(port, path);
      expect(reply.status, path).toBe(404);
      expect(reply.body, path).not.toContain('secret');
    }
  });

  it('says so when the UI isn’t built', async () => {
    const kit = createTestKit();
    cleanups.push(() => kit.shutdown());
    const server = await serve({
      source: backstage(kit.system),
      scheduler: kit.scheduler,
      log: inspectSystem(kit.system).log,
      port: 0,
      host: '127.0.0.1',
      uiDir: join(dir, 'nowhere'),
    });
    cleanups.push(() => server.close());
    const reply = await call(Number(new URL(server.url).port), '/');
    expect(reply.status).toBe(404);
    expect(reply.body).toContain('npm run build');
  });
});

describe('serveBackstage: /events', () => {
  it('sends a hello at once, then events batched every 50 ms on the system’s scheduler', async () => {
    const { kit, port } = await start();
    kit.system.spawn(idle, 'first');
    await kit.settle();

    const stream = await openStream(port);
    expect(stream.res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    const greeting = hello(await stream.next());
    expect(greeting.system).toBe('stage');
    expect(greeting.actors.map((a) => a.path)).toEqual(['/user/first']);

    const start_ = kit.scheduler.now();
    kit.system.spawn(idle, 'second');
    kit.system.spawn(idle, 'third');
    await kit.settle();
    // Nothing goes out until the batch's timer, which is on the system's scheduler.
    expect(kit.scheduler.nextTimerAt()).toBe(start_ + BATCH_MS);
    await roundTrip(port);
    expect(stream.messages).toHaveLength(1);

    await kit.advance(BATCH_MS);
    const batch = await stream.next();
    const spawned = events(batch).filter((e) => e.type === 'spawned');
    expect(spawned.map((e) => e.path)).toEqual(['/user/second', '/user/third']);
    expect(batch.every((f) => f.type === 'event')).toBe(true);
    // One timer per batch: none is left once it has gone.
    expect(kit.scheduler.nextTimerAt()).toBeUndefined();
  });

  it('gives a reconnect a fresh hello, with what happened while it was away', async () => {
    const { kit, port } = await start();
    const first = await openStream(port);
    expect(hello(await first.next()).actors).toEqual([]);
    first.close();
    await first.ended;

    kit.system.spawn(idle, 'meanwhile');
    await kit.advance(BATCH_MS);

    const second = await openStream(port);
    const greeting = hello(await second.next());
    expect(greeting.actors.map((a) => a.path)).toEqual(['/user/meanwhile']);
    expect(greeting.history.map((e) => e.type)).toContain('spawned');
  });

  it('drops a connection that stops reading, which then reconnects to a fresh hello', async () => {
    const { kit, port } = await start({ maxBuffered: 64 * 1024 });
    const ref = kit.system.spawn(idle, 'busy');
    const stuck = await openStream(port);
    await stuck.next();
    stuck.res.pause();
    // An object, since TypeScript can't see the callback change a plain local.
    const state = { dropped: false };
    void stuck.ended.then(() => (state.dropped = true));
    // Big messages, until the socket's buffers are full and the server's passes its limit.
    const big = 'x'.repeat(1_500);
    for (let round = 0; round < 200 && !state.dropped; round++) {
      for (let i = 0; i < 100; i++) ref.tell(big);
      await kit.advance(BATCH_MS);
      await roundTrip(port);
    }
    expect(state.dropped).toBe(true);

    const again = await openStream(port);
    expect(hello(await again.next()).actors.map((a) => a.path)).toEqual(['/user/busy']);
  });
});

describe('serveBackstage: /request', () => {
  it('answers a request with the source’s response', async () => {
    const { kit, port } = await start();
    const ref = kit.system.spawn(idle, 'counter');
    ref.tell('a');
    ref.tell('b');
    await kit.settle();
    const reply = await post(port, JSON.stringify({ type: 'state', path: '/user/counter' }));
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(reply.body)).toEqual({
      ok: true,
      type: 'state',
      path: '/user/counter',
      state: 2,
    });
    // A request the source can't answer is still a response, as in-process.
    const missing = await post(port, JSON.stringify({ type: 'state', path: '/user/nobody' }));
    expect(missing.status).toBe(200);
    expect(JSON.parse(missing.body)).toMatchObject({ ok: false, error: { name: 'NotFoundError' } });
    const unknown = await post(port, JSON.stringify({ type: 'tell', path: '/user/counter' }));
    expect(JSON.parse(unknown.body)).toMatchObject({ ok: false, error: { name: 'TypeError' } });
  });

  it('refuses a body that isn’t JSON, isn’t sent as JSON, or is too big', async () => {
    const { port } = await start();
    const bad = await post(port, '{nope');
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body)).toMatchObject({ ok: false, error: { name: 'TypeError' } });

    // A form post, as a page on another site could send without asking first.
    const form = await post(port, 'type=state', 'application/x-www-form-urlencoded');
    expect(form.status).toBe(415);
    const plain = await post(port, '{"type":"state","path":"/user"}', 'text/plain');
    expect(plain.status).toBe(415);

    const huge = await post(port, JSON.stringify({ type: 'state', path: 'x'.repeat(MAX_BODY) }));
    expect(huge.status).toBe(413);
    expect(JSON.parse(huge.body)).toMatchObject({ ok: false, error: { name: 'RangeError' } });

    const charset = await post(
      port,
      '{"type":"state","path":"/user"}',
      'application/json; charset=utf-8',
    );
    expect(charset.status).toBe(200);
  });

  it('allows only GET for the UI and /events, and only POST for /request', async () => {
    const { port } = await start();
    for (const [method, path, allow] of [
      ['GET', '/request', 'POST'],
      ['POST', '/events', 'GET'],
      ['POST', '/', 'GET'],
      ['DELETE', '/assets/app.js', 'GET'],
    ] as const) {
      const reply = await call(port, path, { method });
      expect(reply.status, `${method} ${path}`).toBe(405);
      expect(reply.headers.allow, `${method} ${path}`).toBe(allow);
    }
  });
});

describe('serveBackstage: who may ask', () => {
  it('refuses a request with another Host header, on every path', async () => {
    const { port } = await start();
    for (const path of ['/', '/events', '/request']) {
      for (const host of [`evil.example:${String(port)}`, '127.0.0.1:1', 'evil.example']) {
        const reply = await call(port, path, {
          method: path === '/request' ? 'POST' : 'GET',
          headers: { Host: host, 'Content-Type': 'application/json' },
          body: path === '/request' ? '{"type":"state","path":"/user"}' : '',
        });
        expect(reply.status, `${path} with Host ${host}`).toBe(403);
      }
    }
    // Names for the address it serves are fine.
    for (const host of [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`]) {
      expect((await call(port, '/', { headers: { Host: host } })).status, host).toBe(200);
    }
  });

  it('sends no CORS headers, to a preflight or anything else', async () => {
    const { port } = await start();
    const origin = { Origin: 'https://evil.example' };
    const replies = [
      await call(port, '/request', {
        method: 'OPTIONS',
        headers: {
          ...origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      }),
      await call(port, '/', { headers: origin }),
      await call(port, '/request', {
        method: 'POST',
        headers: { ...origin, 'Content-Type': 'application/json' },
        body: '{"type":"state","path":"/user"}',
      }),
    ];
    expect(replies[0]?.status).toBe(405);
    for (const reply of replies) expect(corsHeaders(reply)).toEqual([]);
    const stream = await openStream(port, origin);
    expect(corsHeaders(stream.res)).toEqual([]);
    stream.close();
  });
});

describe('hostCheck', () => {
  it('lets a loopback server answer any loopback name, with its port', () => {
    const check = hostCheck('127.0.0.1', 7070);
    for (const ok of ['127.0.0.1:7070', 'localhost:7070', 'LOCALHOST:7070', '[::1]:7070']) {
      expect(check(ok), ok).toBe(true);
    }
    for (const no of [
      '127.0.0.1:7071',
      '127.0.0.1',
      'evil.example:7070',
      '127.0.0.1.nip.io:7070',
      'user@127.0.0.1:7070',
      '127.0.0.1:7070/x',
      '192.168.1.5:7070',
      undefined,
      '',
      '[nope',
    ]) {
      expect(check(no), String(no)).toBe(false);
    }
    expect(hostCheck('::1', 80)('[::1]')).toBe(true);
    expect(hostCheck('localhost', 80)('127.0.0.1:80')).toBe(true);
  });

  it('lets a server on every address answer IP addresses and localhost, never another name', () => {
    for (const wildcard of ['0.0.0.0', '::', '[::]']) {
      const check = hostCheck(wildcard, 7070);
      for (const ok of ['192.168.1.5:7070', '[fe80::1]:7070', 'localhost:7070', '127.0.0.1:7070']) {
        expect(check(ok), `${wildcard} ${ok}`).toBe(true);
      }
      for (const no of ['evil.example:7070', 'my-laptop.local:7070', '192.168.1.5:7071']) {
        expect(check(no), `${wildcard} ${no}`).toBe(false);
      }
    }
  });

  it('lets a server on one other address answer only that address', () => {
    const check = hostCheck('192.168.1.5', 7070);
    expect(check('192.168.1.5:7070')).toBe(true);
    expect(check('localhost:7070')).toBe(false);
    expect(check('127.0.0.1:7070')).toBe(false);
    expect(hostCheck('My-Laptop.local', 7070)('my-laptop.local:7070')).toBe(true);
  });
});

describe('serveBackstage: starting and stopping', () => {
  it('close() sends what’s pending, ends every stream, closes the source and stops listening', async () => {
    const { kit, server, port, closeSource } = await start();
    const one = await openStream(port);
    const two = await openStream(port);
    await one.next();
    await two.next();
    kit.system.spawn(idle, 'last');
    await kit.settle();

    await server.close();
    await Promise.all([one.ended, two.ended]);
    for (const stream of [one, two]) {
      expect(stream.res.complete).toBe(true);
      expect(events(stream.messages.flat()).map((e) => e.type)).toContain('spawned');
    }
    expect(closeSource).toHaveBeenCalledTimes(1);
    // Its batch timer went with it.
    expect(kit.scheduler.nextTimerAt()).toBeUndefined();
    await expect(call(port, '/')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    // Again, it's the same close.
    await server.close();
    expect(closeSource).toHaveBeenCalledTimes(1);
  });

  it('close() doesn’t wait for idle keep-alive connections', async () => {
    const { server, port } = await start();
    const { Agent } = await import('node:http');
    const agent = new Agent({ keepAlive: true });
    cleanups.push(() => {
      agent.destroy();
    });
    await new Promise<void>((done, fail) => {
      request({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
        res.resume();
        res.on('end', done);
      })
        .on('error', fail)
        .end();
    });
    await server.close();
  });

  it('with port 0, reports the port it got, and serves there', async () => {
    const kit = createTestKit({ system: { name: 'public' } });
    cleanups.push(() => kit.shutdown());
    const server = await serveBackstage(kit.system, { port: 0 });
    cleanups.push(() => server.close());
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const port = Number(new URL(server.url).port);
    expect(port).toBeGreaterThan(0);
    const stream = await openStream(port);
    expect(hello(await stream.next()).system).toBe('public');
    // The real UI folder is beside dist/, and src/ has none, so this is the not-built page.
    expect((await call(port, '/')).status).toBe(404);
    stream.close();
  });

  it('rejects when it can’t listen, and closes its source', async () => {
    const taken = createServer();
    await new Promise<void>((done) => taken.listen(0, '127.0.0.1', done));
    cleanups.push(() => new Promise((done) => taken.close(done)));
    const { port } = taken.address() as AddressInfo;
    const kit = createTestKit();
    cleanups.push(() => kit.shutdown());
    const real = backstage(kit.system);
    const closeSource = vi.fn(() => {
      real.close();
    });
    const source: BackstageSource = { ...real, close: closeSource };
    await expect(
      serve({
        source,
        scheduler: kit.scheduler,
        log: inspectSystem(kit.system).log,
        port,
        host: '127.0.0.1',
        uiDir,
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(closeSource).toHaveBeenCalledTimes(1);
  });

  it('throws on bad options and systems at once, before anything listens', () => {
    const kit = createTestKit();
    cleanups.push(() => kit.shutdown());
    for (const opts of [
      { port: -1 },
      { port: 65_536 },
      { port: 1.5 },
      { port: '7070' },
      { host: '' },
      { host: 1 },
      { hots: 'localhost' },
      null,
    ]) {
      expect(() => serveBackstage(kit.system, opts as never), JSON.stringify(opts)).toThrow(
        TypeError,
      );
    }
    expect(() => serveBackstage({} as never)).toThrow(TypeError);
  });
});
