// The wire format (decision 0025). A message that leaves a node is JSON text, and every ref in it
// becomes a URI naming the cluster, the node's address and uid, and the actor's path. Decoding
// turns each URI back into a ref: a live local actor, a ref whose tells are dead letters, or a
// remote ref from remoting. Nothing here throws: a message that can't be sent, or text a peer
// sent that can't be read, is a problem with the path to its first bad part.

import { checkInt, describe } from '../checks.js';
import { defineKey, jsonCopy, keyPath, type JsonValue } from '../json.js';
import type { SystemHooks } from '../internal.js';
import type { AnyRef } from '../types.js';

/** One incarnation of one node: where other nodes reach it, and its uid, new on every start. */
export interface NodeId {
  /** The cluster's name, which every node in it shares. */
  readonly cluster: string;
  /** The address other nodes reach this one at, such as `node-1:2552`. */
  readonly address: string;
  readonly uid: number;
}

/** A parsed ref URI: `troupe://<cluster>@<address>#<uid><path>`. */
export interface RefAddress extends NodeId {
  /** The actor's path on its node, such as `/user/box-office`. */
  readonly path: string;
}

/** What a codec needs from its node. */
export interface CodecOptions {
  /** This node. */
  readonly self: NodeId;
  /** The system's hooks, to find local actors by path and to make dead refs. */
  readonly hooks: SystemHooks;
  /**
   * Makes a ref to an actor on another node, or an old incarnation of one: remoting's job.
   * `uri` is the ref's full path.
   */
  readonly remote: (uri: string, address: RefAddress) => AnyRef;
}

/** What encoding a message gives. */
export type Encoded =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly problem: string };

/** What decoding a frame's text gives. */
export type Decoded =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly problem: string };

/** Encodes and decodes messages for one node. */
export interface Codec {
  /**
   * The message as JSON text, with every ref as a `{ "$ref": uri }` and every key that starts
   * with `$` given one more, so data can't forge a marker. A problem names the first part that
   * isn't JSON plus refs this system made.
   */
  encode(message: unknown): Encoded;
  /** The text back as a message, with its refs resolved. A problem names the first bad part. */
  decode(text: string): Decoded;
  /** The full URI of a path on this node, for a ref or a sender that leaves it. */
  uri(path: string): string;
}

const SCHEME = 'troupe://';
const CLUSTER_NAME = /^[a-z0-9-]+$/;
// What a transport address may hold: anything but the URI's separators and whitespace.
const ADDRESS = /^[^@#/\s]+$/;
// Path segments are actor names or generated names (src/names.ts), so URIs need no escaping.
const REF_URI =
  /^troupe:\/\/([a-z0-9-]+)@([^@#/\s]+)#(0|[1-9][0-9]{0,15})((?:\/[A-Za-z0-9._~$-]+)+)$/;

/**
 * Makes the codec for one node.
 * @throws TypeError if `self` has a bad cluster name, address or uid.
 */
export function createCodec(opts: CodecOptions): Codec {
  const { self, hooks, remote } = opts;
  checkNodeId(self);
  const prefix = `${SCHEME}${self.cluster}@${self.address}#${String(self.uid)}`;
  const uri = (path: string): string => (path.startsWith(SCHEME) ? path : `${prefix}${path}`);

  const refHook = (value: object, at: string) => {
    if (!isRefShaped(value)) return undefined;
    if (!hooks.owns(value)) return { problem: `${at} is a ref from another actor system` };
    return { value: { $ref: uri(value.path) } };
  };
  const copyHooks = { ref: refHook, key: escapeKey };

  const deadRef = (path: string): AnyRef =>
    hooks.makeRef<unknown>(path, (message) => {
      hooks.deadLetter(path, message, 'stopped');
    });

  const resolve = (text: string, at: string): AnyRef | string => {
    const address = parseRefUri(text);
    if (address === undefined) return `${at} is not a ref URI`;
    if (address.cluster !== self.cluster) {
      return `${at} is a ref in cluster "${address.cluster}", not "${self.cluster}"`;
    }
    if (address.address !== self.address) return remote(text, address);
    // An old incarnation of this node: its actors are gone, whatever their paths.
    if (address.uid !== self.uid) return deadRef(text);
    return hooks.lookup(address.path) ?? deadRef(address.path);
  };

  return {
    encode(message) {
      try {
        const copied = jsonCopy(message, copyHooks);
        return copied.ok ? { ok: true, text: JSON.stringify(copied.value) } : copied;
      } catch (error) {
        // A throwing getter, a revoked proxy, or nesting deeper than the stack.
        return { ok: false, problem: `$ can't be read: ${errorText(error)}` };
      }
    },
    decode(text) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        return { ok: false, problem: `$ is not JSON: ${errorText(error)}` };
      }
      try {
        return { ok: true, value: unescape(parsed as JsonValue, '$', resolve) };
      } catch (error) {
        if (error instanceof DecodeProblem) return { ok: false, problem: error.text };
        return { ok: false, problem: `$ can't be decoded: ${errorText(error)}` };
      }
    },
    uri,
  };
}

/** Parses a ref URI, or gives `undefined` if `text` isn't one. */
export function parseRefUri(text: string): RefAddress | undefined {
  const match = REF_URI.exec(text);
  if (match === null) return undefined;
  const [, cluster, address, uid, path] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  const n = Number(uid);
  if (!Number.isSafeInteger(n)) return undefined;
  return { cluster, address, uid: n, path };
}

/** Throws `TypeError` unless `id` is a usable node identity. */
export function checkNodeId(id: NodeId): void {
  if (typeof id.cluster !== 'string' || !CLUSTER_NAME.test(id.cluster)) {
    throw new TypeError(
      `cluster name must be lower-case letters, digits and "-", got ${describe(id.cluster)}`,
    );
  }
  if (typeof id.address !== 'string' || !ADDRESS.test(id.address)) {
    throw new TypeError(
      `address must be non-empty, without "@", "#", "/" or spaces, got ${describe(id.address)}`,
    );
  }
  checkInt(id.uid, 'uid', { min: 0 });
}

/** Whether `value` has a ref's shape, as Backstage's encoding recognises refs (decision 0021). */
function isRefShaped(value: object): value is AnyRef {
  const { path, tell, ask } = value as { path?: unknown; tell?: unknown; ask?: unknown };
  return typeof path === 'string' && typeof tell === 'function' && typeof ask === 'function';
}

function escapeKey(key: string): string {
  return key.startsWith('$') ? `$${key}` : key;
}

class DecodeProblem extends Error {
  constructor(readonly text: string) {
    super(text);
  }
}

/**
 * The decoded message: `$$` keys lose their first `$`, and `{ "$ref": uri }` becomes a ref. Any
 * other key starting with a single `$` is a marker this version doesn't know.
 */
function unescape(
  value: JsonValue,
  at: string,
  resolve: (uri: string, at: string) => AnyRef | string,
): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) {
    const items = value as readonly JsonValue[];
    return items.map((item, i) => unescape(item, `${at}[${String(i)}]`, resolve));
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  const keys = Object.keys(record);
  const marker = keys.find((key) => key.startsWith('$') && !key.startsWith('$$'));
  if (marker !== undefined) {
    const target = record.$ref;
    if (marker !== '$ref' || keys.length !== 1 || typeof target !== 'string') {
      throw new DecodeProblem(`${at} has an unknown marker "${marker}"`);
    }
    const ref = resolve(target, at);
    if (typeof ref === 'string') throw new DecodeProblem(ref);
    return ref;
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const name = key.startsWith('$') ? key.slice(1) : key;
    defineKey(out, name, unescape(record[key] as JsonValue, `${at}${keyPath(name)}`, resolve));
  }
  return out;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
