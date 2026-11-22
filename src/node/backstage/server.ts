// The Backstage server: the built UI, the protocol's frames as server-sent events, and requests
// as JSON posts, on node:http with no dependency (decision 0023). Localhost only by default, and
// it refuses any Host header that isn't a name for the address it serves, so a page on another
// site can't reach it through DNS rebinding.

import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backstage } from '../../backstage/source.js';
import type {
  BackstageRequest,
  BackstageResponse,
  BackstageSource,
  Frame,
} from '../../backstage/types.js';
import { checkInt, checkKeys, describe } from '../../checks.js';
import { inspectSystem } from '../../internal.js';
import type { Logger } from '../../logger.js';
import type { Scheduler } from '../../scheduler.js';
import type { ActorSystem } from '../../types.js';

/** Options for {@link serveBackstage}. */
export interface BackstageServerOptions {
  /** The port to listen on. Default 7070. `0` picks a free one, which `url` reports. */
  port?: number;
  /**
   * The address to listen on. Default `127.0.0.1`. Backstage shows every message and every
   * state, so any address but a loopback one shows them to whoever can reach it.
   */
  host?: string;
}

/** A running Backstage server. */
export interface BackstageServer {
  /** Where to open it, such as `http://127.0.0.1:7070/`. */
  readonly url: string;
  /** Stops serving, ends every connection and closes the source. Calling it again waits for the first. */
  close(): Promise<void>;
}

const OPTIONS = new Set(['port', 'host']);
const DEFAULT_PORT = 7070;
const DEFAULT_HOST = '127.0.0.1';

/** How often a connection gets the events that have happened since, in ms. */
export const BATCH_MS = 50;
/** How much a connection may leave unsent before it's dropped, in bytes. */
export const MAX_BUFFERED = 1024 * 1024;
/** The largest request body, in bytes. */
export const MAX_BODY = 64 * 1024;
/** How long an `EventSource` waits before it reconnects, in ms. */
export const RETRY_MS = 1_000;

// From dist/node/backstage/ to dist/backstage-ui/, where the build puts the UI.
const UI_DIR = fileURLToPath(new URL('../../backstage-ui/', import.meta.url));

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Sent with every response. No Access-Control-* header ever: the UI is same-origin.
const COMMON_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
} as const;

const CSP = "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";

/**
 * Serves Backstage for `system`: the UI at `/`, its frames as server-sent events at `/events`,
 * batched every 50 ms on the system's scheduler, and read-only requests posted as JSON to
 * `/request`. Node only. It listens on `127.0.0.1:7070` unless told otherwise, and refuses
 * requests whose `Host` header isn't a name for that address.
 * @throws TypeError, at once, unless `system` was made by `createActorSystem`, `opts.port` is an
 * integer from 0 to 65535, and `opts.host` is a non-empty string.
 * @returns A promise of the server once it's listening, which rejects if it can't listen.
 */
export function serveBackstage(
  system: ActorSystem,
  opts?: BackstageServerOptions,
): Promise<BackstageServer> {
  const { port, host } = checkOptions(opts);
  const inspection = inspectSystem(system);
  return serve({
    source: backstage(system),
    scheduler: inspection.scheduler,
    log: inspection.log,
    port,
    host,
    uiDir: UI_DIR,
  });
}

/** What {@link serve} needs. Tests give their own source and UI folder. */
export interface ServeOptions {
  readonly source: BackstageSource;
  readonly scheduler: Scheduler;
  readonly log: Logger;
  readonly port: number;
  readonly host: string;
  /** The folder the UI is served from. */
  readonly uiDir: string;
  /** Default {@link MAX_BUFFERED}. */
  readonly maxBuffered?: number;
}

interface Stream {
  readonly res: ServerResponse;
  pending: Frame[];
  disconnect: () => void;
}

/** Serves `opts.source`. It owns the source from now on, and closes it on close or on failure. */
export async function serve(opts: ServeOptions): Promise<BackstageServer> {
  const { source, scheduler, log } = opts;
  const maxBuffered = opts.maxBuffered ?? MAX_BUFFERED;
  const uiDir = resolve(opts.uiDir);
  const streams = new Set<Stream>();
  let cancelFlush: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  // Set once listening, since port 0 learns its port then.
  let allowed: (header: string | undefined) => boolean = () => false;

  const write = (stream: Stream, frames: readonly Frame[]): void => {
    stream.res.write(`data: ${JSON.stringify(frames)}\n\n`);
    // A tab that stopped reading. It reconnects when it can, with a fresh hello.
    if (stream.res.writableLength > maxBuffered) end(stream, true);
  };

  const end = (stream: Stream, destroy = false): void => {
    if (!streams.delete(stream)) return;
    stream.disconnect();
    if (destroy) stream.res.destroy();
    else stream.res.end();
  };

  const flush = (): void => {
    cancelFlush = undefined;
    for (const stream of streams) {
      if (stream.pending.length === 0) continue;
      const frames = stream.pending;
      stream.pending = [];
      write(stream, frames);
    }
  };

  const openStream = (res: ServerResponse): void => {
    res.writeHead(200, {
      ...COMMON_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
    });
    res.write(`retry: ${String(RETRY_MS)}\n\n`);
    const stream: Stream = { res, pending: [], disconnect: () => undefined };
    streams.add(stream);
    // The hello comes at once, in connect, and goes out on its own. Events wait for the batch.
    stream.disconnect = source.connect((frame) => {
      if (frame.type === 'hello') {
        write(stream, [frame]);
        return;
      }
      stream.pending.push(frame);
      cancelFlush ??= scheduler.setTimer(flush, BATCH_MS);
    });
    // The response's close, not the request's, which closes once its (empty) body is read.
    res.on('close', () => {
      end(stream);
    });
  };

  const answerRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const type = req.headers['content-type'] ?? '';
    if (!/^application\/json\s*(;|$)/i.test(type)) {
      sendJson(res, 415, refusal('TypeError', 'a request must be sent as application/json'));
      req.resume();
      return;
    }
    const body = await readBody(req, MAX_BODY);
    if (body === undefined) {
      sendJson(
        res,
        413,
        refusal('RangeError', `a request must be at most ${String(MAX_BODY)} bytes`),
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, refusal('TypeError', 'a request must be JSON'));
      return;
    }
    // The source checks the request itself, and answers a bad one with a TypeError response.
    sendJson(res, 200, await source.request(parsed as BackstageRequest));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!allowed(req.headers.host)) {
      sendText(res, 403, 'Backstage refuses this Host header.\n');
      req.resume();
      return;
    }
    const path = pathOf(req.url);
    const method = path === '/request' ? 'POST' : 'GET';
    if (req.method !== method) {
      notAllowed(req, res, method);
    } else if (path === '/events') {
      openStream(res);
    } else if (path === '/request') {
      await answerRequest(req, res);
    } else {
      await serveFile(res, uiDir, path);
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log.error('the Backstage server failed a request', { error });
      if (!res.headersSent) sendText(res, 500, 'Backstage failed this request.\n');
      else res.destroy();
    });
  });

  try {
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(opts.port, opts.host, () => {
        server.off('error', fail);
        done();
      });
    });
  } catch (error) {
    source.close();
    throw error;
  }

  const { port } = server.address() as AddressInfo;
  allowed = hostCheck(opts.host, port);

  return Object.freeze({
    url: `http://${openableHost(opts.host)}:${String(port)}/`,
    close(): Promise<void> {
      closing ??= new Promise<void>((done) => {
        server.close(() => {
          done();
        });
        cancelFlush?.();
        // What has happened goes out before the streams end.
        flush();
        for (const stream of streams) end(stream);
        source.close();
        // Keep-alive sockets would otherwise hold close() open.
        server.closeAllConnections();
      });
      return closing;
    },
  });
}

function checkOptions(opts: unknown): { port: number; host: string } {
  if (opts === undefined) return { port: DEFAULT_PORT, host: DEFAULT_HOST };
  checkKeys(opts, OPTIONS, 'serveBackstage');
  const { port = DEFAULT_PORT, host = DEFAULT_HOST } = opts as { port?: unknown; host?: unknown };
  checkInt(port, 'serveBackstage: port', { min: 0 });
  if ((port as number) > 65_535) {
    throw new TypeError(`serveBackstage: port must be at most 65535, got ${describe(port)}`);
  }
  if (typeof host !== 'string' || host === '') {
    throw new TypeError(`serveBackstage: host must be a non-empty string, got ${describe(host)}`);
  }
  return { port: port as number, host };
}

const bare = (host: string): string =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host.toLowerCase();

const WILDCARDS = new Set(['0.0.0.0', '::']);
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);
const isLoopback = (host: string): boolean =>
  LOOPBACK_NAMES.has(host) || (isIP(host) === 4 && host.startsWith('127.'));

/**
 * Which `Host` headers a server on `host` and `port` answers. The port must match. A loopback
 * server answers any loopback name. A server on every address answers any IP address and
 * `localhost`, but never another name, which is what DNS rebinding needs. Otherwise only the
 * address it was given.
 */
export function hostCheck(host: string, port: number): (header: string | undefined) => boolean {
  const bound = bare(host);
  return (header) => {
    if (header === undefined || header === '') return false;
    let url: URL;
    try {
      url = new URL(`http://${header}`);
    } catch {
      return false;
    }
    // Anything but host and port, such as user@host, isn't a Host header.
    if (url.host !== header.toLowerCase() && `${url.host}:80` !== header.toLowerCase()) {
      return false;
    }
    if ((url.port === '' ? '80' : url.port) !== String(port)) return false;
    const name = bare(url.hostname);
    if (WILDCARDS.has(bound)) return name === 'localhost' || isIP(name) !== 0;
    if (isLoopback(bound)) return isLoopback(name);
    return name === bound;
  };
}

/** A host a browser can open: a wildcard means this machine. */
function openableHost(host: string): string {
  const name = bare(host);
  if (name === '0.0.0.0') return '127.0.0.1';
  if (name === '::') return '[::1]';
  return isIP(name) === 6 ? `[${name}]` : name;
}

function pathOf(url: string | undefined): string {
  try {
    return decodeURIComponent(new URL(url ?? '/', 'http://backstage').pathname);
  } catch {
    // A malformed escape: no file has that name.
    return '/\0';
  }
}

async function serveFile(res: ServerResponse, uiDir: string, path: string): Promise<void> {
  const name = path === '/' ? 'index.html' : path.slice(1);
  const file = resolve(uiDir, name);
  if (!file.startsWith(uiDir + sep) || name.includes('\0')) {
    sendText(res, 404, 'Not found.\n');
    return;
  }
  let content: Buffer;
  try {
    content = await readFile(file);
  } catch (error) {
    if (isMissing(error)) {
      sendText(
        res,
        404,
        path === '/' ? 'The Backstage UI is not built. Run npm run build.\n' : 'Not found.\n',
      );
      return;
    }
    throw error;
  }
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, {
    ...COMMON_HEADERS,
    'Content-Type': type,
    ...(type.startsWith('text/html') ? { 'Content-Security-Policy': CSP } : {}),
  });
  res.end(content);
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR';
}

/** The body as text, or `undefined` once it passes `limit` bytes. */
function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) over = true;
      if (!over) chunks.push(chunk);
    });
    req.on('end', () => {
      done(over ? undefined : Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', fail);
  });
}

function refusal(name: string, message: string): BackstageResponse {
  return { ok: false, error: { name, message } };
}

function notAllowed(req: IncomingMessage, res: ServerResponse, allow: string): void {
  req.resume();
  res.writeHead(405, { ...COMMON_HEADERS, Allow: allow, 'Content-Type': 'text/plain' });
  res.end('Method not allowed.\n');
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { ...COMMON_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendJson(res: ServerResponse, status: number, body: BackstageResponse): void {
  res.writeHead(status, { ...COMMON_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
