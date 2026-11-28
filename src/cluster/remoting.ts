// Remoting (decision 0026): `tell` on a remote ref becomes a frame on a connection, and a frame
// becomes a `tell` on a local ref. One connection per pair of nodes, so messages from one node to
// one actor arrive in the order they were sent. At most once: nothing is acknowledged or retried,
// and an ask that loses its message or its reply times out (decision 0009).
//
// Each connection starts with a hello each way, and carries nothing else until both have
// arrived. When two nodes dial each other at once, the connection the lower address dialed wins,
// so the loser never carries a message. While a peer has no connection, its frames wait in a
// bounded buffer, and remoting dials again with backoff from the system's scheduler and random.

import { checkInt, checkKeys } from '../checks.js';
import { hooksOf, type SystemHooks, type Watcher, type WatchTarget } from '../internal.js';
import { Queue } from '../queue.js';
import type { ActorSystem, AnyRef, DeadLetterReason } from '../types.js';
import type { Connection, Transport } from './transport.js';
import {
  checkNodeId,
  createCodec,
  parseRefUri,
  type Codec,
  type EntityRefs,
  type NodeId,
  type RefAddress,
} from './wire.js';

/** The remoting protocol's version, in every hello. A peer on another version is refused. */
export const PROTOCOL = 1;

/** Options for {@link startRemoting}. */
export interface RemotingOptions {
  /** The cluster's name, which every node shares: lower-case letters, digits and `-`. */
  cluster: string;
  /** How this node reaches the others. Its `address` is this node's. */
  transport: Transport;
  /** How many messages wait for a peer that has no connection. Default 10,000. */
  bufferSize?: number;
  /** The largest frame remoting sends, in UTF-8 bytes. Default 1 MiB. */
  maxFrameBytes?: number;
  /**
   * Whether remoting closes by itself once the system has terminated. Default true. The cluster
   * turns it off, so it can say goodbye first and close remoting itself (decision 0028).
   */
  closeWithSystem?: boolean;
}

/** A peer's incarnation, as its hello named it. */
export interface PeerId {
  readonly address: string;
  readonly uid: number;
}

/** What a control frame's handler gets: who sent it, and the frame, parsed. */
export type ControlHandler = (from: PeerId, frame: Readonly<Record<string, unknown>>) => void;

/** Remoting for one node. */
export interface Remoting {
  /** This node: the cluster, its address, and its uid, drawn from the system's `random`. */
  readonly self: NodeId;
  /** The codec for messages to and from this node (decision 0025). */
  readonly codec: Codec;
  /** Resolves once the transport is listening. */
  readonly whenListening: Promise<void>;
  /**
   * The ref a ref URI decodes to on this node: a local actor, a dead ref, or a remote ref.
   * @throws TypeError if `uri` isn't a ref URI in this cluster.
   */
  ref(uri: string): AnyRef;
  /**
   * The node at `address` is down, from membership (decision 0028). Its buffered messages become
   * `unreachable` dead letters, as does everything sent to it later, every watch on it signals
   * `terminated`, and its incarnation can't connect again. A new uid at the address can. With
   * `uid`, only that incarnation goes: if remoting already knows a newer one at the address, only
   * the old one's watches end. When the downed incarnation dials again, it's sent a `downed`
   * frame before it's refused, so it can learn that it's down.
   */
  nodeDown(address: string, uid?: number): void;
  /**
   * Sends a control frame to `address` if a connection is open, and returns true. Otherwise it
   * starts a dial, drops the frame and returns false: membership's frames are sent again on its
   * next tick, so waiting for a connection would only deliver stale ones.
   */
  signal(address: string, frame: Readonly<Record<string, unknown>>): boolean;
  /** Handles frames whose type remoting doesn't know, such as membership's. One handler. */
  onControl(handler: ControlHandler): void;
  /** Called with each peer incarnation once a connection to it is established. One handler. */
  onPeer(handler: (peer: PeerId) => void): void;
  /** Gives the codec sharding's entity refs (decision 0030). Once. */
  setEntities(refs: EntityRefs): void;
  /**
   * How membership settles a split (decision 0042): `side` says what this node's side of the
   * cluster is, sent in every hello, and `lost` is called when a node this one has downed, and
   * that has downed this one, turns out to have the larger side. Once.
   */
  onSplit(hooks: SplitHooks): void;
  /**
   * Closes the transport. Everything sent afterwards is a `terminated` dead letter. Runs by
   * itself once the system has terminated.
   */
  close(): Promise<void>;
}

const OPTIONS = new Set(['cluster', 'transport', 'bufferSize', 'maxFrameBytes', 'closeWithSystem']);
const BACKOFF_MIN_MS = 100;
const BACKOFF_MAX_MS = 5_000;
const UID_RANGE = 2 ** 32;
const DOWNED_FRAME = JSON.stringify({ t: 'downed' });
// How long a connection may go without the peer's hello, as long as the TCP transport gives a
// peer to prove the secret. Without it, a dial whose hello was lost waits for good (T7, 0042).
const HELLO_TIMEOUT_MS = 5_000;

/** A connection, and what this node knows about it. */
interface Link {
  readonly connection: Connection;
  /** The address of the node that dialed it, for the tie-break. */
  readonly dialer: string;
  readonly outbound: boolean;
  /** Known from the start for an outbound link, and from its hello for an inbound one. */
  peer: Peer | undefined;
  gotHello: boolean;
  /** Closed on purpose by this node, so its close starts nothing. */
  abandoned: boolean;
  /** Calls off the wait for the peer's hello. */
  cancelHello: (() => void) | undefined;
}

/** A message waiting for a connection, with what its dead letter needs. */
interface Waiting {
  readonly frame: string;
  /** For a message, not a control frame: what becomes a dead letter if it can't be sent. */
  readonly letter: { readonly recipient: string; readonly message: unknown } | undefined;
}

/** Another node, by address. */
interface Peer {
  readonly address: string;
  /** Its current incarnation, once a hello has said. */
  uid: number | undefined;
  /** Set by `nodeDown`. Cleared by a hello from a new incarnation. */
  down: boolean;
  /** The incarnation that was downed, which can't connect again. */
  downUid: number | undefined;
  /** The connection with hellos both ways. */
  link: Link | undefined;
  /** This node's outbound connection, waiting for its hello. */
  dialing: Link | undefined;
  readonly waiting: Queue<Waiting>;
  /** Dials in a row that closed before their hello. */
  attempts: number;
  cancelRetry: (() => void) | undefined;
  /** This node's actors that the peer watches, by URI. */
  readonly watchedBy: Map<string, { readonly target: WatchTarget; readonly watcher: Watcher }>;
}

interface Hello {
  readonly cluster: string;
  readonly protocol: number;
  readonly address: string;
  readonly uid: number;
  /** The uid at the hearer's address that the sender has down, if any (0042). */
  readonly down?: number;
  /** The uid at the hearer's address that the sender has as a member, if any (0042). */
  readonly up?: number;
  /** The sender's side of the cluster, as membership sees it (0042). */
  readonly side?: Side;
}

/**
 * One side of a split cluster: how many members are up on it, where its first seed is in the
 * seed list every node shares, if it has one, and its lowest address.
 */
export interface Side {
  readonly size: number;
  readonly seed?: number;
  readonly lowest: string;
}

/** What membership gives remoting to settle a split with (decision 0042). */
export interface SplitHooks {
  /** This node's side: its up and leaving members, as it sees them. */
  side(): Side;
  /** The uid of the member at `address` this node has up or leaving, if any. */
  member(address: string): number | undefined;
  /** `peer`, in another cluster than this node's, has the larger side. */
  lost(peer: PeerId): void;
}

/**
 * Whether side `a` keeps the cluster over side `b` when two clusters meet: the larger, then at
 * the same size the one holding the earlier seed, then the one with the lower lowest address.
 * Both ends of a hello compute it, from opposite ends, so exactly one side gives way.
 */
export function beats(a: Side, b: Side): boolean {
  if (a.size !== b.size) return a.size > b.size;
  const sa = a.seed ?? Infinity;
  const sb = b.seed ?? Infinity;
  if (sa !== sb) return sa < sb;
  return a.lowest < b.lowest;
}

function isSide(value: unknown): value is Side {
  return (
    isRecord(value) &&
    typeof value.size === 'number' &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    (value.seed === undefined ||
      (typeof value.seed === 'number' && Number.isSafeInteger(value.seed) && value.seed >= 0)) &&
    typeof value.lowest === 'string'
  );
}

/**
 * Starts remoting on `system`: listens on the transport, and makes refs to other nodes' actors
 * work as local ones do.
 * @throws TypeError for options that can't be used.
 * @throws Error if the system already has remoting.
 */
export function startRemoting(system: ActorSystem, opts: RemotingOptions): Remoting {
  checkKeys(opts, OPTIONS, 'startRemoting');
  const {
    cluster,
    transport,
    bufferSize = 10_000,
    maxFrameBytes = 1_048_576,
    closeWithSystem = true,
  } = opts;
  if (!isTransport(transport)) {
    throw new TypeError('startRemoting: transport must be a Transport');
  }
  checkInt(bufferSize, 'startRemoting: bufferSize', { min: 0 });
  checkInt(maxFrameBytes, 'startRemoting: maxFrameBytes');
  if (typeof closeWithSystem !== 'boolean') {
    throw new TypeError('startRemoting: closeWithSystem must be a boolean');
  }
  const hooks = hooksOf(system);
  const self: NodeId = Object.freeze({
    cluster,
    address: transport.address,
    uid: Math.floor(hooks.random() * UID_RANGE),
  });
  checkNodeId(self);
  return new Node(system, hooks, self, transport, bufferSize, maxFrameBytes, closeWithSystem).api;
}

/** Remoting's state for one node. */
class Node {
  readonly api: Remoting;
  readonly #hooks: SystemHooks;
  readonly #self: NodeId;
  readonly #transport: Transport;
  readonly #bufferSize: number;
  readonly #maxFrameBytes: number;
  readonly #codec: Codec;
  #split: SplitHooks | undefined;
  readonly #peers = new Map<string, Peer>();
  // Connections still waiting for their hello, so closing can call off every wait.
  readonly #awaitingHello = new Set<Link>();
  // The address behind every remote ref this node made, so watching one finds its node.
  readonly #remoteRefs = new WeakMap<object, RefAddress>();
  // Remote actors this node's actors and probes watch, by URI.
  readonly #targets = new Map<string, RemoteTarget>();
  #closed = false;
  #closing: Promise<void> | undefined;
  #onControl: ControlHandler | undefined;
  #onPeer: ((peer: PeerId) => void) | undefined;
  #entities: EntityRefs | undefined;

  constructor(
    system: ActorSystem,
    hooks: SystemHooks,
    self: NodeId,
    transport: Transport,
    bufferSize: number,
    maxFrameBytes: number,
    closeWithSystem: boolean,
  ) {
    this.#hooks = hooks;
    this.#self = self;
    this.#transport = transport;
    this.#bufferSize = bufferSize;
    this.#maxFrameBytes = maxFrameBytes;
    this.#codec = createCodec({
      self,
      hooks,
      remote: (uri, address) => this.#remoteRef(uri, address),
      entities: () => this.#entities,
    });

    hooks.setWatchResolver((ref) => this.#watchTarget(ref));
    const whenListening = transport.listen(
      (connection) => {
        this.#accept(connection);
      },
      (reason) => {
        hooks.log.warn(`remoting: ${reason}`);
      },
    );
    whenListening.catch((error: unknown) => {
      hooks.log.error('remoting: the transport could not listen', {
        address: self.address,
        error,
      });
    });
    if (closeWithSystem) void system.whenTerminated.then(() => this.#close());
    this.api = Object.freeze({
      self,
      codec: this.#codec,
      whenListening,
      ref: (uri: string) => this.#ref(uri),
      nodeDown: (address: string, uid?: number) => {
        this.#nodeDown(address, uid);
      },
      signal: (address: string, frame: Readonly<Record<string, unknown>>) =>
        this.#signal(address, frame),
      onControl: (handler: ControlHandler) => {
        if (this.#onControl !== undefined) throw new Error('remoting: onControl is already set');
        this.#onControl = handler;
      },
      onPeer: (handler: (peer: PeerId) => void) => {
        if (this.#onPeer !== undefined) throw new Error('remoting: onPeer is already set');
        this.#onPeer = handler;
      },
      onSplit: (hooks: SplitHooks) => {
        if (this.#split !== undefined) throw new Error('remoting: onSplit is already set');
        this.#split = hooks;
      },
      setEntities: (refs: EntityRefs) => {
        if (this.#entities !== undefined) throw new Error('remoting: entities are already set');
        this.#entities = refs;
      },
      close: () => this.#close(),
    });
  }

  // ---- refs ----

  #ref(uri: string): AnyRef {
    const decoded = this.#codec.decodeValue({ $ref: uri });
    if (!decoded.ok) throw new TypeError(`remoting: ${decoded.problem}`);
    return decoded.value as AnyRef;
  }

  #remoteRef(uri: string, address: RefAddress): AnyRef {
    const ref = this.#hooks.makeRef<unknown>(uri, (message) => {
      this.#tell(address.address, uri, message, address.uid);
    });
    this.#remoteRefs.set(ref, address);
    return ref;
  }

  #tell(address: string, uri: string, message: unknown, uid?: number): void {
    const hooks = this.#hooks;
    if (this.#closed) {
      hooks.deadLetter(uri, message, 'terminated');
      return;
    }
    const encoded = this.#codec.encode(message);
    if (!encoded.ok) {
      this.#unserializable(uri, message, encoded.problem);
      return;
    }
    const sender = hooks.sender();
    const from = sender === undefined ? '' : `,"from":${JSON.stringify(this.#codec.uri(sender))}`;
    const frame = `{"t":"msg","to":${JSON.stringify(uri)}${from},"m":${encoded.text}}`;
    if (frame.length > this.#maxFrameBytes / 3 && utf8Bytes(frame) > this.#maxFrameBytes) {
      this.#unserializable(
        uri,
        message,
        `the frame is ${String(utf8Bytes(frame))} bytes, over maxFrameBytes (${String(this.#maxFrameBytes)})`,
      );
      return;
    }
    this.#send(this.#peer(address), frame, { recipient: uri, message }, uid);
  }

  #unserializable(uri: string, message: unknown, problem: string): void {
    this.#hooks.log.warn(`remoting: a message to ${uri} can't be sent: ${problem}`, {
      recipient: uri,
    });
    this.#hooks.deadLetter(uri, message, 'unserializable');
  }

  // ---- peers and connections ----

  #peer(address: string): Peer {
    let peer = this.#peers.get(address);
    if (peer === undefined) {
      peer = {
        address,
        uid: undefined,
        down: false,
        downUid: undefined,
        link: undefined,
        dialing: undefined,
        waiting: new Queue(),
        attempts: 0,
        cancelRetry: undefined,
        watchedBy: new Map(),
      };
      this.#peers.set(address, peer);
    }
    return peer;
  }

  /**
   * Sends a frame now, or buffers it until the peer has a connection. `uid` is the incarnation
   * the frame is for, when its ref names one: a frame for another incarnation than the one that
   * was downed at the address waits for it, and dials, rather than being dropped (T7).
   */
  #send(peer: Peer, frame: string, letter: Waiting['letter'], uid?: number): void {
    if (peer.down && (uid === undefined || uid === peer.downUid)) {
      this.#drop(letter, 'unreachable');
      return;
    }
    if (peer.link !== undefined && !peer.down) {
      peer.link.connection.send(frame);
      return;
    }
    if (peer.waiting.size >= this.#bufferSize) {
      this.#drop(letter, 'unreachable');
      return;
    }
    peer.waiting.push({ frame, letter });
    this.#dialSoon(peer, peer.down);
  }

  #signal(address: string, frame: Readonly<Record<string, unknown>>): boolean {
    if (this.#closed) return false;
    const peer = this.#peer(address);
    if (peer.link !== undefined && !peer.down) {
      peer.link.connection.send(JSON.stringify(frame));
      return true;
    }
    // Membership signals an address only for a member it thinks is live, so it dials even an
    // address remoting has down: the down incarnation may be an old one this node never reached,
    // and only a hello says which uid answers. A downed one is refused at its hello (T7).
    this.#dialSoon(peer, true);
    return false;
  }

  #drop(letter: Waiting['letter'], reason: DeadLetterReason): void {
    if (letter !== undefined) this.#hooks.deadLetter(letter.recipient, letter.message, reason);
  }

  #dialSoon(peer: Peer, evenIfDown = false): void {
    if (this.#closed || (peer.down && !evenIfDown)) return;
    if (peer.link !== undefined || peer.dialing !== undefined || peer.cancelRetry !== undefined) {
      return;
    }
    if (peer.attempts === 0) {
      this.#dial(peer);
      return;
    }
    // Doubling from the minimum, with jitter so nodes that lost the same peer don't dial together.
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (peer.attempts - 1));
    const delay = Math.round(ceiling * (0.5 + this.#hooks.random() / 2));
    peer.cancelRetry = this.#hooks.scheduler.setTimer(() => {
      peer.cancelRetry = undefined;
      // A retry that finds the peer connected, or down, has nothing to do.
      if (
        peer.dialing === undefined &&
        peer.link === undefined &&
        !this.#closed &&
        (evenIfDown || !peer.down)
      ) {
        this.#dial(peer);
      }
    }, delay);
  }

  /**
   * This node's hello to `peer`: who it is, and for settling a split (0042), the uid it has down
   * at the peer's address and its side of the cluster.
   */
  #hello(peer: Peer | undefined): string {
    const self = this.#self;
    const hello: Record<string, unknown> = {
      t: 'hello',
      cluster: self.cluster,
      protocol: PROTOCOL,
      address: self.address,
      uid: self.uid,
    };
    if (peer?.down === true && peer.downUid !== undefined) hello.down = peer.downUid;
    const up = peer === undefined ? undefined : this.#split?.member(peer.address);
    if (up !== undefined) hello.up = up;
    const side = this.#split?.side();
    if (side !== undefined) hello.side = side;
    return JSON.stringify(hello);
  }

  #dial(peer: Peer): void {
    const connection = this.#transport.connect(peer.address);
    const link: Link = {
      connection,
      dialer: this.#self.address,
      outbound: true,
      peer,
      gotHello: false,
      abandoned: false,
      cancelHello: undefined,
    };
    peer.dialing = link;
    this.#wire(link);
    connection.send(this.#hello(peer));
  }

  #accept(connection: Connection): void {
    if (this.#closed) {
      connection.close();
      return;
    }
    // The dialer's address isn't known until its hello: the empty string stands in until then.
    const link: Link = {
      connection,
      dialer: '',
      outbound: false,
      peer: undefined,
      gotHello: false,
      abandoned: false,
      cancelHello: undefined,
    };
    this.#wire(link);
  }

  #wire(link: Link): void {
    this.#awaitingHello.add(link);
    link.cancelHello = this.#hooks.scheduler.setTimer(() => {
      link.cancelHello = undefined;
      this.#awaitingHello.delete(link);
      if (!link.gotHello && !link.abandoned) {
        this.#refuse(link, `no hello within ${String(HELLO_TIMEOUT_MS)} ms`);
      }
    }, HELLO_TIMEOUT_MS);
    link.connection.onFrame((text) => {
      this.#onFrame(link, text);
    });
    link.connection.onClose((error) => {
      this.#onClose(link, error);
    });
  }

  #stopWaitingForHello(link: Link): void {
    link.cancelHello?.();
    link.cancelHello = undefined;
    this.#awaitingHello.delete(link);
  }

  /** Closes a link on purpose, so its close doesn't count as a failure or start a dial. */
  #abandon(link: Link): void {
    link.abandoned = true;
    this.#stopWaitingForHello(link);
    const peer = link.peer;
    if (peer?.link === link) peer.link = undefined;
    if (peer?.dialing === link) peer.dialing = undefined;
    link.connection.close();
  }

  #onClose(link: Link, error: unknown): void {
    if (link.abandoned) return;
    link.abandoned = true;
    this.#stopWaitingForHello(link);
    const peer = link.peer;
    if (peer === undefined) return;
    if (peer.link === link) {
      peer.link = undefined;
      this.#hooks.log.debug(`remoting: lost the connection to ${peer.address}`, {
        address: peer.address,
        error,
      });
    } else if (peer.dialing === link) {
      peer.dialing = undefined;
      peer.attempts++;
    } else {
      return;
    }
    if (peer.waiting.size > 0) this.#dialSoon(peer);
  }

  #establish(peer: Peer, link: Link): void {
    peer.link = link;
    if (peer.dialing === link) peer.dialing = undefined;
    peer.attempts = 0;
    peer.cancelRetry?.();
    peer.cancelRetry = undefined;
    for (let next = peer.waiting.shift(); next !== undefined; next = peer.waiting.shift()) {
      link.connection.send(next.frame);
    }
    // Set by the hello that established the link.
    if (peer.uid !== undefined) this.#onPeer?.({ address: peer.address, uid: peer.uid });
  }

  // ---- frames ----

  #onFrame(link: Link, text: string): void {
    if (this.#closed || link.abandoned) return;
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      frame = undefined;
    }
    if (!isRecord(frame) || typeof frame.t !== 'string') {
      this.#refuse(link, `it sent a frame that isn't one: ${preview(text)}`);
      return;
    }
    if (!link.gotHello) {
      if (frame.t !== 'hello') {
        this.#refuse(link, `it sent "${frame.t}" before its hello`);
        return;
      }
      this.#onHello(link, frame);
      return;
    }
    const peer = link.peer;
    if (peer === undefined) return;
    switch (frame.t) {
      case 'msg':
        this.#onMessage(peer, frame);
        return;
      case 'watch':
        this.#onWatch(peer, frame);
        return;
      case 'unwatch':
        this.#onUnwatch(peer, frame);
        return;
      case 'terminated':
        this.#onTerminated(frame);
        return;
      default:
        if (this.#onControl !== undefined && peer.uid !== undefined) {
          this.#onControl({ address: peer.address, uid: peer.uid }, frame);
          return;
        }
        this.#hooks.log.warn(`remoting: ignored a "${frame.t}" frame from ${peer.address}`, {
          address: peer.address,
        });
    }
  }

  /** Logs why a connection is refused, and closes it. `claimed` is the address its hello gave. */
  #refuse(link: Link, why: string, claimed?: unknown): void {
    const address = link.peer?.address ?? (typeof claimed === 'string' ? claimed : undefined);
    this.#hooks.log.warn(
      `remoting: refused the connection with ${address ?? 'a peer'}: ${why}`,
      address === undefined ? {} : { address },
    );
    this.#abandon(link);
    const peer = link.peer;
    // A refused dial counts as a failed one, so the next waits its backoff.
    if (peer !== undefined && link.outbound) {
      peer.attempts++;
      if (peer.waiting.size > 0) this.#dialSoon(peer);
    }
  }

  #onHello(link: Link, frame: Record<string, unknown>): void {
    link.gotHello = true;
    this.#stopWaitingForHello(link);
    const hello = frame as Partial<Hello>;
    const problem = this.#checkHello(link, hello);
    if (problem !== undefined) {
      // An inbound peer hears this node's hello first, so it can log the mismatch too.
      if (!link.outbound) link.connection.send(this.#hello(undefined));
      this.#refuse(link, problem, hello.address);
      return;
    }
    const { address, uid } = hello as Hello;
    const peer = this.#peer(address);
    if (!link.outbound) {
      link.peer = peer;
      (link as { dialer: string }).dialer = address;
    }
    if (peer.down && peer.downUid === uid) {
      // Told before it's refused, so a node that was downed while it was still running learns
      // that it's down, and leaves (decision 0028), whichever of the two dialed.
      if (!link.outbound) link.connection.send(this.#hello(peer));
      link.connection.send(DOWNED_FRAME);
      this.#refuse(link, `${address}#${String(uid)} was downed, and can rejoin only as a new uid`);
      this.#settleSplit(hello as Hello, true);
      return;
    }
    this.#settleSplit(hello as Hello, false);
    if (peer.uid !== undefined && peer.uid !== uid) {
      this.#incarnationGone(peer, `restarted as uid ${String(uid)}`, link);
    }
    peer.uid = uid;
    peer.down = false;
    peer.downUid = undefined;
    // Watches made before this node knew the peer's uid, on another incarnation, end now.
    this.#endTargets(address, uid, `${address} is now uid ${String(uid)}`);
    const rival = peer.link ?? peer.dialing;
    if (rival !== undefined && rival !== link) {
      if (keepsOver(rival, link)) {
        this.#hooks.log.debug(`remoting: kept the connection ${rival.dialer} dialed`, {
          address,
        });
        this.#abandon(link);
        return;
      }
      this.#abandon(rival);
    }
    if (!link.outbound) link.connection.send(this.#hello(peer));
    this.#establish(peer, link);
  }

  /**
   * Settles a split at a hello (0042). The two nodes are in different clusters if either has the
   * other down while the other doesn't count it a member: after a split their views disagreed
   * on, or after one side restarted. The smaller side gives way, and its nodes rejoin the larger
   * as new incarnations. A node downed by one that it still counts a member is no split: it's
   * told it's down, and leaves (0028).
   */
  #settleSplit(hello: Hello, downed: boolean): void {
    const split = this.#split;
    if (split === undefined || !isSide(hello.side)) return;
    const self = this.#self.uid;
    const separate =
      (downed && hello.up !== self) ||
      (hello.down === self && split.member(hello.address) !== hello.uid);
    if (separate && beats(hello.side, split.side())) {
      split.lost({ address: hello.address, uid: hello.uid });
    }
  }

  #checkHello(link: Link, hello: Partial<Hello>): string | undefined {
    const self = this.#self;
    if (hello.cluster !== self.cluster) {
      return `its cluster is ${describeValue(hello.cluster)}, not "${self.cluster}"`;
    }
    if (hello.protocol !== PROTOCOL) {
      return `its protocol is ${describeValue(hello.protocol)}, not ${String(PROTOCOL)}`;
    }
    const { address, uid } = hello;
    if (typeof address !== 'string' || address === '' || /[@#/\s]/.test(address)) {
      return `its address is ${describeValue(address)}`;
    }
    if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 0) {
      return `its uid is ${describeValue(uid)}`;
    }
    if (address === self.address) return 'it has this node’s own address';
    if (link.outbound && address !== link.peer?.address) {
      return `it says it's ${address}, not ${String(link.peer?.address)}`;
    }
    return undefined;
  }

  #onMessage(peer: Peer, frame: Record<string, unknown>): void {
    const hooks = this.#hooks;
    const { to, from, m } = frame;
    const target = typeof to === 'string' ? this.#local(to) : undefined;
    if (target === undefined) {
      hooks.log.warn(`remoting: a message from ${peer.address} has a bad recipient`, {
        address: peer.address,
        to,
      });
      return;
    }
    const decoded = this.#codec.decodeValue(m);
    if (!decoded.ok) {
      hooks.log.warn(
        `remoting: a message from ${peer.address} to ${String(to)} can't be decoded: ${decoded.problem}`,
        { address: peer.address },
      );
      hooks.deadLetter(target.recipient, m, 'unserializable');
      return;
    }
    if (target.ref === undefined) {
      hooks.deadLetter(target.recipient, decoded.value, target.reason);
      return;
    }
    const sender = typeof from === 'string' && parseRefUri(from) !== undefined ? from : undefined;
    hooks.tellFrom(target.ref, decoded.value, sender);
  }

  /**
   * The local actor a URI from a peer names, or why there's none: a stopped actor, an ask that's
   * done, or an old incarnation of this node. `undefined` for a URI that isn't this node's.
   */
  #local(
    uri: string,
  ):
    | { readonly ref: AnyRef; readonly recipient: string }
    | { readonly ref: undefined; readonly recipient: string; readonly reason: DeadLetterReason }
    | undefined {
    const address = parseRefUri(uri);
    const self = this.#self;
    if (address?.cluster !== self.cluster || address.address !== self.address) return undefined;
    if (address.uid !== self.uid) return { ref: undefined, recipient: uri, reason: 'stopped' };
    const ref = this.#hooks.lookup(address.path);
    if (ref !== undefined) return { ref, recipient: address.path };
    const reason = address.path.startsWith('/temp/') ? 'askCompleted' : 'stopped';
    return { ref: undefined, recipient: address.path, reason };
  }

  // ---- death watch ----

  #watchTarget(ref: unknown): WatchTarget | undefined {
    if (typeof ref !== 'object' || ref === null) return undefined;
    const address = this.#remoteRefs.get(ref);
    if (address === undefined) return undefined;
    const uri = (ref as AnyRef).path;
    const existing = this.#targets.get(uri);
    if (existing !== undefined) return existing;
    const target = new RemoteTarget(ref as AnyRef, address, {
      register: (t) => {
        this.#targets.set(uri, t);
        this.#control(address.address, { t: 'watch', to: uri });
      },
      unregister: (t) => {
        if (this.#targets.get(uri) === t) this.#targets.delete(uri);
        this.#control(address.address, { t: 'unwatch', to: uri });
      },
      ended: (t) => {
        if (this.#targets.get(uri) === t) this.#targets.delete(uri);
      },
    });
    const peer = this.#peers.get(address.address);
    if (peer !== undefined && (peer.down || (peer.uid !== undefined && peer.uid !== address.uid))) {
      target.end(nodeGone(address.address, peer.down ? 'down' : 'restarted'));
    }
    return target;
  }

  #control(address: string, frame: Record<string, unknown>): void {
    if (this.#closed) return;
    this.#send(this.#peer(address), JSON.stringify(frame), undefined);
  }

  #onWatch(peer: Peer, frame: Record<string, unknown>): void {
    const { to } = frame;
    if (typeof to !== 'string' || peer.watchedBy.has(to)) return;
    const local = this.#local(to);
    const target = local?.ref === undefined ? undefined : this.#hooks.watchTarget(local.ref);
    if (target === undefined || target.terminated) {
      this.#control(peer.address, terminatedFrame(to, target?.failure));
      return;
    }
    const watcher: Watcher = {
      notifyTerminated: (ended) => {
        peer.watchedBy.delete(to);
        this.#control(peer.address, terminatedFrame(to, ended.failure));
      },
    };
    peer.watchedBy.set(to, { target, watcher });
    target.addWatcher(watcher);
  }

  #onUnwatch(peer: Peer, frame: Record<string, unknown>): void {
    const { to } = frame;
    if (typeof to !== 'string') return;
    const watch = peer.watchedBy.get(to);
    if (watch === undefined) return;
    peer.watchedBy.delete(to);
    watch.target.removeWatcher(watch.watcher);
  }

  #onTerminated(frame: Record<string, unknown>): void {
    const { ref, failure } = frame;
    if (typeof ref !== 'string') return;
    const target = this.#targets.get(ref);
    if (target === undefined) {
      // An unwatch crossed it on the way, or this node's watch ended first.
      this.#hooks.log.debug(`remoting: a terminated for ${ref}, which nothing here watches`);
      return;
    }
    target.end(failure === undefined ? undefined : { error: rebuild(failure) });
  }

  /** Ends every watch on the node at `address` that isn't on incarnation `keep`. */
  #endTargets(address: string, keep: number | undefined, why: string): void {
    for (const target of [...this.#targets.values()]) {
      if (target.address.address === address && target.address.uid !== keep) {
        target.end(nodeGone(address, why));
      }
    }
  }

  /**
   * The peer's incarnation has gone: a new uid at its address, or downed. Its connections close,
   * its watches on this node's actors are dropped, and this node's watches on it end.
   */
  #incarnationGone(peer: Peer, why: string, keep?: Link): void {
    for (const link of [peer.link, peer.dialing]) {
      if (link !== undefined && link !== keep) this.#abandon(link);
    }
    for (const { target, watcher } of peer.watchedBy.values()) target.removeWatcher(watcher);
    peer.watchedBy.clear();
    this.#endTargets(peer.address, undefined, why);
  }

  #nodeDown(address: string, uid: number | undefined): void {
    const peer = this.#peer(address);
    if (uid !== undefined && peer.uid !== undefined && peer.uid !== uid) {
      // A newer incarnation is here already. The old one's watches end, and nothing else.
      this.#endTargets(address, peer.uid, 'down');
      return;
    }
    if (peer.down) return;
    peer.down = true;
    peer.downUid = uid ?? peer.uid;
    peer.cancelRetry?.();
    peer.cancelRetry = undefined;
    for (let next = peer.waiting.shift(); next !== undefined; next = peer.waiting.shift()) {
      this.#drop(next.letter, 'unreachable');
    }
    this.#incarnationGone(peer, 'down');
  }

  #close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    for (const link of [...this.#awaitingHello]) this.#stopWaitingForHello(link);
    for (const peer of this.#peers.values()) {
      peer.cancelRetry?.();
      peer.cancelRetry = undefined;
      for (let next = peer.waiting.shift(); next !== undefined; next = peer.waiting.shift()) {
        this.#drop(next.letter, 'terminated');
      }
      for (const { target, watcher } of peer.watchedBy.values()) target.removeWatcher(watcher);
      peer.watchedBy.clear();
    }
    this.#closing = this.#transport.close();
    return this.#closing;
  }
}

/** What a {@link RemoteTarget} tells remoting. */
interface TargetOwner {
  /** Its first watcher arrived: send the peer a watch. */
  register(target: RemoteTarget): void;
  /** Its last watcher left: send the peer an unwatch. */
  unregister(target: RemoteTarget): void;
  ended(target: RemoteTarget): void;
}

/** A remote actor that local actors watch, standing in for its cell. */
class RemoteTarget implements WatchTarget {
  readonly ref: AnyRef;
  readonly address: RefAddress;
  terminated = false;
  failure: { readonly error: unknown } | undefined;
  readonly #owner: TargetOwner;
  readonly #watchers = new Set<Watcher>();
  #registered = false;

  constructor(ref: AnyRef, address: RefAddress, owner: TargetOwner) {
    this.ref = ref;
    this.address = address;
    this.#owner = owner;
  }

  addWatcher(watcher: Watcher): void {
    if (this.terminated) return;
    this.#watchers.add(watcher);
    if (this.#registered) return;
    this.#registered = true;
    this.#owner.register(this);
  }

  removeWatcher(watcher: Watcher): void {
    if (!this.#watchers.delete(watcher) || this.#watchers.size > 0 || !this.#registered) return;
    this.#registered = false;
    this.#owner.unregister(this);
  }

  end(failure: { readonly error: unknown } | undefined): void {
    if (this.terminated) return;
    this.terminated = true;
    this.failure = failure;
    this.#registered = false;
    this.#owner.ended(this);
    const watchers = [...this.#watchers];
    this.#watchers.clear();
    for (const watcher of watchers) watcher.notifyTerminated(this);
  }
}

/** Of two links to one peer, whether `existing` wins: the one the lower address dialed. */
function keepsOver(existing: Link, incoming: Link): boolean {
  // The same dialer dials again only once its old link has gone, whether or not this node knows.
  if (existing.dialer === incoming.dialer) return false;
  return existing.dialer < incoming.dialer;
}

function terminatedFrame(
  uri: string,
  failure: { readonly error: unknown } | undefined,
): Record<string, unknown> {
  if (failure === undefined) return { t: 'terminated', ref: uri };
  const { error } = failure;
  const described =
    error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: 'Error', message: String(error) };
  return { t: 'terminated', ref: uri, failure: described };
}

/** A failure from the wire as an `Error` with the original's name and message, without a stack. */
function rebuild(failure: unknown): Error {
  const { name, message } = isRecord(failure) ? failure : {};
  const error = new Error(typeof message === 'string' ? message : 'the remote actor failed');
  if (typeof name === 'string') error.name = name;
  return error;
}

function nodeGone(address: string, why: string): { readonly error: Error } {
  return { error: new Error(`node ${address} is gone: ${why}`) };
}

/** Whether `value` has a transport's shape. */
export function isTransport(value: unknown): value is Transport {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.address === 'string' &&
    typeof t.listen === 'function' &&
    typeof t.connect === 'function' &&
    typeof t.close === 'function'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'missing';
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}

function preview(text: string): string {
  return text.length > 80 ? `${JSON.stringify(text.slice(0, 80))}…` : JSON.stringify(text);
}

/** The UTF-8 length of `text`, without allocating. Lone surrogates count as the 3 bytes of U+FFFD. */
export function utf8Bytes(text: string): number {
  let bytes = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) {
      bytes += 1;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // Two code units, four bytes.
        bytes += 2;
        i++;
      } else {
        bytes += 2;
      }
    } else {
      bytes += 2;
    }
  }
  return bytes;
}
