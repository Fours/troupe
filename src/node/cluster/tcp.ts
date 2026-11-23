// The TCP transport (decision 0027): length-prefixed frames on node:net, and a challenge-response
// on a shared secret before any other frame. Remoting does the rest: the hello, reconnecting with
// backoff on the system's scheduler, and buffering while a peer is away (decision 0026). So this
// file has no timers of its own, only the socket's idle timeout while a peer proves the secret.
//
// The proof: each side sends a random nonce, and answers the other's with an HMAC-SHA256 under the
// secret of both nonces and its role. The role is in the MAC so a proof can't be reflected back
// to the side that made it, and a challenge that comes back unchanged is refused outright.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  connect as dial,
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net';
import { checkInt, checkKeys, describe } from '../../checks.js';
import type { Connection, Transport } from '../../cluster/transport.js';
import { encodeFrame, FrameDecoder } from './frames.js';

/** Options for {@link tcpTransport}. */
export interface TcpTransportOptions {
  /** The port to listen on. */
  port: number;
  /** The interface to listen on. Default `127.0.0.1`: only this machine can connect. */
  host?: string;
  /**
   * The address other nodes dial, as `host:port`, when it isn't `host` and `port`: in Docker,
   * say, where a node listens on `0.0.0.0` and is reached by its service name.
   */
  advertise?: string;
  /**
   * Shared by every node in the cluster. It never crosses the wire: each side proves it knows it
   * by answering the other's random challenge.
   */
  secret: string;
  /**
   * The largest frame accepted from a peer, in UTF-8 bytes. A larger one closes the connection.
   * Default 1 MiB, the same as remoting's own limit on what it sends.
   */
  maxFrameBytes?: number;
}

/** A transport with what tests need to see inside it. Never exported from the entry point. */
export interface TcpNode {
  readonly transport: Transport;
  /** Every connection that hasn't closed yet, both ways. */
  readonly connections: ReadonlySet<TcpConnection>;
  /** Where the server is bound, once it's listening. */
  bound(): AddressInfo | undefined;
  /**
   * Ends everything at once, as `kill -9` would: every socket is reset, so frames still on their
   * way are lost and the other ends see an error, and nothing here is told.
   */
  kill(): void;
}

const OPTIONS = new Set(['port', 'host', 'advertise', 'secret', 'maxFrameBytes']);
const PROTOCOL = 'troupe-tcp/1';
const NONCE_BYTES = 32;
const MAC_BYTES = 32;
const HEX = /^[0-9a-f]+$/;
// A challenge or a proof is under 200 bytes: nothing bigger is buffered from an unproven peer.
const AUTH_LIMIT_BYTES = 256;
const AUTH_TIMEOUT_MS = 5_000;

/**
 * A transport on TCP, for nodes in separate processes. Each frame is a 4-byte big-endian length
 * and UTF-8 JSON text. Peers prove the shared secret before any other frame, and one that can't
 * is disconnected. Connections aren't encrypted: keep cluster traffic on a private network.
 * @throws TypeError for options that can't be used.
 */
export function tcpTransport(opts: TcpTransportOptions): Transport {
  return openTcpTransport(opts).transport;
}

/**
 * {@link tcpTransport}, with its insides showing. `authTimeoutMs` is for tests, which can't wait
 * the real 5 s.
 * @throws TypeError for options that can't be used.
 */
export function openTcpTransport(
  opts: TcpTransportOptions,
  { authTimeoutMs = AUTH_TIMEOUT_MS }: { readonly authTimeoutMs?: number } = {},
): TcpNode {
  checkKeys(opts, OPTIONS, 'tcpTransport');
  const { port, host = '127.0.0.1', advertise, secret, maxFrameBytes = 1_048_576 } = opts;
  checkInt(port, 'tcpTransport: port');
  if (port > 65_535)
    throw new TypeError(`tcpTransport: port must be at most 65535, got ${String(port)}`);
  if (typeof host !== 'string' || host === '' || /\s/.test(host)) {
    throw new TypeError(`tcpTransport: host must be a host name or IP, got ${describe(host)}`);
  }
  if (advertise !== undefined && (typeof advertise !== 'string' || !parseAddress(advertise))) {
    throw new TypeError(`tcpTransport: advertise must be "host:port", got ${describe(advertise)}`);
  }
  if (typeof secret !== 'string' || secret === '') {
    throw new TypeError('tcpTransport: secret must be a non-empty string');
  }
  checkInt(maxFrameBytes, 'tcpTransport: maxFrameBytes');
  const address = advertise ?? formatAddress(host, port);
  const node = new Node({ address, host, port, secret, maxFrameBytes, authTimeoutMs });
  return {
    transport: node.transport,
    connections: node.connections,
    bound: () => node.bound(),
    kill: () => {
      node.kill();
    },
  };
}

interface Settings {
  readonly address: string;
  readonly host: string;
  readonly port: number;
  readonly secret: string;
  readonly maxFrameBytes: number;
  readonly authTimeoutMs: number;
}

/** One node's transport: a server, and the connections both ways. */
class Node {
  readonly transport: Transport;
  readonly connections = new Set<TcpConnection>();
  readonly settings: Settings;
  onRefused: ((reason: string) => void) | undefined;
  #server: Server | undefined;
  #gone = false;
  #closing: Promise<void> | undefined;

  constructor(settings: Settings) {
    this.settings = settings;
    this.transport = Object.freeze({
      address: settings.address,
      listen: (
        onConnection: (connection: Connection) => void,
        onRefused?: (reason: string) => void,
      ) => this.#listen(onConnection, onRefused),
      connect: (to: string) => this.#connect(to),
      close: () => this.#close(),
    });
  }

  bound(): AddressInfo | undefined {
    const bound = this.#server?.address();
    return typeof bound === 'object' && bound !== null ? bound : undefined;
  }

  #listen(
    onConnection: (connection: Connection) => void,
    onRefused: ((reason: string) => void) | undefined,
  ): Promise<void> {
    if (this.#gone) return Promise.reject(new Error(`${this.settings.address} has closed`));
    if (this.#server !== undefined) {
      return Promise.reject(new Error(`${this.settings.address} is already listening`));
    }
    this.onRefused = onRefused;
    const server = createServer((socket) => {
      if (this.#gone) {
        socket.destroy();
        return;
      }
      new TcpConnection(this, socket, 'acceptor', undefined, onConnection);
    });
    this.#server = server;
    return new Promise((resolve, reject) => {
      server.once('error', (error) => {
        this.#server = undefined;
        reject(error);
      });
      server.listen(this.settings.port, this.settings.host, () => {
        server.removeAllListeners('error');
        // Errors after this are the accepted sockets', and each connection handles its own.
        server.on('error', () => {});
        resolve();
      });
    });
  }

  #connect(to: string): Connection {
    const target = parseAddress(to);
    if (this.#gone || target === undefined) {
      const why = this.#gone ? `${this.settings.address} has closed` : `"${to}" isn't host:port`;
      return TcpConnection.failed(this, new Error(why));
    }
    const socket = dial({ host: target.host, port: target.port });
    return new TcpConnection(this, socket, 'dialer', to, undefined);
  }

  #close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    const wasGone = this.#gone;
    this.#gone = true;
    const server = this.#server;
    const closes = [...this.connections].map((c) => c.closed);
    for (const connection of [...this.connections]) connection.close();
    const stopped =
      wasGone || server === undefined || !server.listening
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            server.close(() => {
              resolve();
            });
          });
    this.#closing = Promise.all([stopped, ...closes]).then(() => undefined);
    return this.#closing;
  }

  kill(): void {
    if (this.#gone) return;
    this.#gone = true;
    this.#closing = Promise.resolve();
    for (const connection of [...this.connections]) connection.vanish();
    this.#server?.close();
  }
}

type Role = 'dialer' | 'acceptor';

/** One connection: the socket, the proof both ways, then frames. */
export class TcpConnection implements Connection {
  readonly socket: Socket | undefined;
  readonly role: Role;
  /** `proving` until the peer has proven the secret, then `open`. */
  state: 'connecting' | 'proving' | 'open' | 'closed';
  /** Frames written to the socket, the challenge and proof included. */
  sent = 0;
  /** Frames read from the socket, the challenge and proof included. */
  received = 0;
  /** Resolves once the connection has closed and its listeners have been told. */
  readonly closed: Promise<void>;
  readonly #node: Node;
  readonly #peer: string | undefined;
  readonly #onOpen: ((connection: Connection) => void) | undefined;
  readonly #decoder = new FrameDecoder(AUTH_LIMIT_BYTES);
  readonly #nonce = randomBytes(NONCE_BYTES).toString('hex');
  readonly #pending: string[] = [];
  readonly #frameListeners: ((frame: string) => void)[] = [];
  #closeListeners: ((error?: unknown) => void)[] = [];
  #peerNonce: string | undefined;
  #error: { readonly error: unknown } | undefined;
  #done = false;
  #ended: () => void = () => {};

  /** A connection that closes at once with `error`, for a dial that can't be made. */
  static failed(node: Node, error: Error): TcpConnection {
    const connection = new TcpConnection(node, undefined, 'dialer', undefined, undefined);
    connection.#error = { error };
    queueMicrotask(() => {
      connection.#finish();
    });
    return connection;
  }

  constructor(
    node: Node,
    socket: Socket | undefined,
    role: Role,
    peer: string | undefined,
    onOpen: ((connection: Connection) => void) | undefined,
  ) {
    this.#node = node;
    this.socket = socket;
    this.role = role;
    this.#peer = peer;
    this.#onOpen = onOpen;
    this.closed = new Promise((resolve) => {
      this.#ended = resolve;
    });
    this.state = role === 'dialer' ? 'connecting' : 'proving';
    if (socket === undefined) return;
    node.connections.add(this);
    socket.setNoDelay(true);
    // The socket's own idle timer, the one clock here: a peer gets this long to prove the secret.
    const timeoutMs = node.settings.authTimeoutMs;
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => {
      this.#refuse(`it didn't prove the secret within ${String(timeoutMs)} ms`);
    });
    socket.on('data', (chunk: Buffer) => {
      this.#onData(chunk);
    });
    socket.on('error', (error) => {
      this.#error ??= { error };
    });
    socket.on('close', () => {
      this.#finish();
    });
    if (role === 'dialer') {
      socket.once('connect', () => {
        if (this.state !== 'connecting') return;
        this.state = 'proving';
        this.#challenge();
      });
    } else {
      this.#challenge();
    }
  }

  send(frame: string): void {
    if (this.state === 'closed') return;
    if (this.state !== 'open') {
      this.#pending.push(frame);
      return;
    }
    this.#write(frame);
  }

  onFrame(listener: (frame: string) => void): void {
    this.#frameListeners.push(listener);
  }

  onClose(listener: (error?: unknown) => void): void {
    if (!this.#done) {
      this.#closeListeners.push(listener);
      return;
    }
    const error = this.#error;
    queueMicrotask(() => {
      if (error === undefined) listener();
      else listener(error.error);
    });
  }

  close(): void {
    if (this.state === 'closed') return;
    const wasOpen = this.state === 'open';
    this.state = 'closed';
    this.#pending.length = 0;
    // What was already written still goes. Before the proof, nothing of ours has been written.
    if (wasOpen) this.socket?.destroySoon();
    else this.socket?.destroy();
  }

  /** Its node was killed: the socket is reset, and nobody here hears of it. */
  vanish(): void {
    this.state = 'closed';
    this.#done = true;
    this.#closeListeners = [];
    this.#frameListeners.length = 0;
    this.#node.connections.delete(this);
    this.socket?.resetAndDestroy();
    this.#ended();
  }

  #onData(chunk: Buffer): void {
    if (this.state === 'closed') return;
    this.#decoder.push(chunk);
    // One frame at a time: the proof raises the limit, and the frames after it in the same chunk
    // are held to the new one.
    for (let next = this.#decoder.next(); next !== undefined; next = this.#decoder.next()) {
      if (next.tooLong !== undefined) {
        this.#refuse(
          `it sent a frame of ${String(next.tooLong)} bytes, over the limit (${String(this.#decoder.limit)})`,
        );
        return;
      }
      this.received++;
      if (this.state === 'open') this.#emit(next.frame);
      else this.#onProof(next.frame);
      // A listener may have closed it, or the proof refused it: a call TypeScript can't see into.
      if (this.#isClosed()) return;
    }
  }

  #isClosed(): boolean {
    return this.state === 'closed';
  }

  #emit(frame: string): void {
    for (const listener of this.#frameListeners) listener(frame);
  }

  #challenge(): void {
    this.#write(JSON.stringify({ t: 'challenge', protocol: PROTOCOL, nonce: this.#nonce }));
  }

  /** A frame from a peer that hasn't proven the secret yet: its challenge, then its proof. */
  #onProof(text: string): void {
    const frame = parse(text);
    if (this.#peerNonce === undefined) {
      if (frame?.t !== 'challenge') {
        this.#refuse('it sent something other than a challenge first');
      } else if (frame.protocol !== PROTOCOL) {
        this.#refuse(`its protocol is ${describe(frame.protocol)}, not "${PROTOCOL}"`);
      } else if (!isHex(frame.nonce, NONCE_BYTES)) {
        this.#refuse('its challenge is malformed');
      } else if (frame.nonce === this.#nonce) {
        this.#refuse('it sent back our own challenge');
      } else {
        this.#peerNonce = frame.nonce;
        this.#write(JSON.stringify({ t: 'proof', mac: this.#mac(this.role) }));
      }
      return;
    }
    if (frame?.t !== 'proof' || !isHex(frame.mac, MAC_BYTES)) {
      this.#refuse('it sent something other than a proof after its challenge');
      return;
    }
    const expected = Buffer.from(this.#mac(this.role === 'dialer' ? 'acceptor' : 'dialer'), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(frame.mac, 'hex'))) {
      this.#refuse('it failed to prove the secret');
      return;
    }
    this.#open();
  }

  #mac(role: Role): string {
    const [dialer, acceptor] =
      this.role === 'dialer'
        ? [this.#nonce, this.#peerNonce as string]
        : [this.#peerNonce as string, this.#nonce];
    return createHmac('sha256', this.#node.settings.secret)
      .update(`${PROTOCOL} ${role} ${dialer} ${acceptor}`)
      .digest('hex');
  }

  #open(): void {
    this.state = 'open';
    this.socket?.setTimeout(0);
    this.#decoder.limit = this.#node.settings.maxFrameBytes;
    for (const frame of this.#pending.splice(0)) this.#write(frame);
    this.#onOpen?.(this);
  }

  /** Drops a peer that broke the rules: it's sent nothing more, and the node is told why. */
  #refuse(why: string): void {
    if (this.state === 'closed') return;
    const reason = `refused the TCP connection with ${this.#who()}: ${why}`;
    this.#error = { error: new Error(reason) };
    this.state = 'closed';
    this.#pending.length = 0;
    this.socket?.destroy();
    this.#node.onRefused?.(reason);
  }

  #who(): string {
    if (this.#peer !== undefined) return this.#peer;
    const socket = this.socket;
    const host = socket?.remoteAddress ?? 'an unknown peer';
    return socket?.remotePort === undefined ? host : formatAddress(host, socket.remotePort);
  }

  #write(frame: string): void {
    this.sent++;
    this.socket?.write(encodeFrame(frame));
  }

  #finish(): void {
    if (this.#done) return;
    this.#done = true;
    this.state = 'closed';
    this.#node.connections.delete(this);
    const error = this.#error;
    for (const listener of this.#closeListeners.splice(0)) {
      if (error === undefined) listener();
      else listener(error.error);
    }
    this.#ended();
  }
}

/** `host:port`, with brackets around an IPv6 host. */
function formatAddress(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${String(port)}` : `${host}:${String(port)}`;
}

/** The host and port in `host:port` or `[ipv6]:port`, or undefined. */
export function parseAddress(address: string): { host: string; port: number } | undefined {
  const match = /^(?:\[([^\]\s]+)\]|([^:[\]\s/@#]+)):(\d{1,5})$/.exec(address);
  if (match === null) return undefined;
  const port = Number(match[3]);
  if (port < 1 || port > 65_535) return undefined;
  return { host: match[1] ?? (match[2] as string), port };
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function isHex(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length === bytes * 2 && HEX.test(value);
}
