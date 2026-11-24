import { describe, expect, it } from 'vitest';
import { actor } from '../../src/actor.js';
import { createCodec, parseRefUri, type Codec, type RefAddress } from '../../src/cluster/wire.js';
import { hooksOf } from '../../src/internal.js';
import { createTestKit, type TestKit } from '../../src/testkit/kit.js';
import { seededRandom } from '../../src/testkit/random.js';
import type { ActorRef, AnyRef } from '../../src/types.js';
import { idle } from '../helpers/actors.js';

// Milestone 4, T1: the wire format (decision 0025).

const SELF = { cluster: 'festival', address: 'node-1:2552', uid: 7 };
const PREFIX = 'troupe://festival@node-1:2552#7';

type Echo = { readonly replyTo: ActorRef<string> };
const echo = actor<Echo, null>({
  initial: null,
  receive: (state, msg) => {
    msg.replyTo.tell('pong');
    return state;
  },
});

interface Setup {
  readonly kit: TestKit;
  readonly codec: Codec;
  /** What the codec asked remoting for. */
  readonly remotes: { uri: string; address: RefAddress }[];
  /** Remote refs remoting gives back by URI, as T2's will, so they compare equal. */
  readonly far: Map<string, AnyRef>;
}

function setup(): Setup {
  const kit = createTestKit();
  const hooks = hooksOf(kit.system);
  const remotes: Setup['remotes'] = [];
  const far = new Map<string, AnyRef>();
  const codec = createCodec({
    self: SELF,
    hooks,
    remote: (uri, address) => {
      remotes.push({ uri, address });
      return far.get(uri) ?? hooks.makeRef(uri, () => undefined);
    },
  });
  return { kit, codec, remotes, far };
}

function roundTrip(codec: Codec, value: unknown): unknown {
  const encoded = codec.encode(value);
  if (!encoded.ok) throw new Error(encoded.problem);
  const decoded = codec.decode(encoded.text);
  if (!decoded.ok) throw new Error(decoded.problem);
  return decoded.value;
}

function textOf(codec: Codec, value: unknown): string {
  const encoded = codec.encode(value);
  if (!encoded.ok) throw new Error(encoded.problem);
  return encoded.text;
}

function problemOf(result: { ok: boolean; problem?: string }): string | undefined {
  return result.ok ? undefined : result.problem;
}

describe('encode and decode', () => {
  it('round-trip every kind of JSON value', () => {
    const { codec } = setup();
    for (const value of [
      null,
      true,
      false,
      0,
      -12.5,
      1e300,
      '',
      'é🎭"\\\n',
      [],
      [1, [2, [3, []]]],
      {},
      { a: { b: [null, { c: 'd' }] }, 'not an identifier': 1 },
    ]) {
      expect(roundTrip(codec, value)).toStrictEqual(value);
    }
  });

  it('give -0 back as 0, as JSON does', () => {
    const { codec } = setup();
    expect(Object.is(roundTrip(codec, -0), 0)).toBe(true);
  });

  it('keep null-prototype objects and __proto__ keys as data', () => {
    const { codec } = setup();
    const bare = Object.create(null) as Record<string, unknown>;
    bare.x = 1;
    expect(roundTrip(codec, bare)).toEqual({ x: 1 });
    const parsed = JSON.parse('{"__proto__":{"x":1},"$__proto__":2}') as unknown;
    const back = roundTrip(codec, parsed) as Record<string, unknown>;
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
    expect(Object.keys(back)).toEqual(['__proto__', '$__proto__']);
    expect(JSON.stringify(back)).toBe('{"__proto__":{"x":1},"$__proto__":2}');
  });

  it('decode to new objects, so the receiver shares nothing with the sender but refs', async () => {
    const { kit, codec } = setup();
    const ref = kit.system.spawn(idle, 'shared');
    const sent = { seats: [1, 2], to: ref };
    const back = roundTrip(codec, sent) as typeof sent;
    expect(back).toStrictEqual(sent);
    expect(back).not.toBe(sent);
    expect(back.seats).not.toBe(sent.seats);
    expect(back.to).toBe(ref);
    await kit.settle();
  });

  it('round-trip refs anywhere in a value', async () => {
    const { kit, codec } = setup();
    const a = kit.system.spawn(idle, 'a');
    const region = hooksOf(kit.system).spawnSystem(idle, 'region');
    const value = { replyTo: a, nested: [{ deep: [region, a] }], list: [a, null] };
    const back = roundTrip(codec, value) as typeof value;
    expect(back).toStrictEqual(value);
    expect(back.nested[0]?.deep[0]).toBe(region);
    expect(roundTrip(codec, a)).toBe(a);
    await kit.settle();
  });

  it('round-trip arbitrary values with refs, $ keys and __proto__ keys (property test)', async () => {
    const { kit, codec, far } = setup();
    const farUri = 'troupe://festival@node-2:2552#3/user/far';
    far.set(
      farUri,
      hooksOf(kit.system).makeRef(farUri, () => undefined),
    );
    const refs = [
      kit.system.spawn(idle, 'p1'),
      kit.system.spawn(idle, 'p2'),
      hooksOf(kit.system).spawnSystem(idle, 'p3'),
      far.get(farUri) as AnyRef,
    ];
    for (let seed = 1; seed <= 300; seed++) {
      const value = arbitrary(seededRandom(seed), refs, 0);
      const back = roundTrip(codec, value);
      expect(back, `seed ${String(seed)}`).toStrictEqual(value);
    }
    await kit.settle();
  });
});

describe('what encode refuses', () => {
  class Seat {
    row = 'A';
  }
  const sym = Symbol('s');

  it('names the first part that is not JSON plus refs', () => {
    const { codec } = setup();
    const cycle: Record<string, unknown> = { a: 1 };
    cycle.self = cycle;
    const holes = [1, , 3]; // eslint-disable-line no-sparse-arrays
    const cases: [unknown, string][] = [
      [{ at: new Map() }, '$.at is not a plain object (Map)'],
      [{ when: new Date(0) }, '$.when is not a plain object (Date)'],
      [{ a: [1, undefined] }, '$.a[1] is undefined'],
      [{ n: NaN }, '$.n is NaN'],
      [[Infinity], '$[0] is Infinity'],
      [{ big: 1n }, '$.big is a bigint'],
      [{ fn: () => 1 }, '$.fn is a function'],
      [{ [sym]: 1 }, '$ has symbol keys'],
      [{ seat: new Seat() }, '$.seat is not a plain object (Seat)'],
      [cycle, '$.self is a cycle'],
      [holes, '$[1] is a hole'],
      [{ 'odd key': undefined }, '$["odd key"] is undefined'],
      [undefined, '$ is undefined'],
    ];
    for (const [value, problem] of cases) {
      expect(problemOf(codec.encode(value)), problem).toBe(problem);
    }
  });

  it('refuses a ref from another system, or a lookalike, at its path', async () => {
    const { kit, codec } = setup();
    const other = createTestKit();
    const foreign = other.system.spawn(idle, 'foreign');
    const ours = kit.system.spawn(idle, 'ours');
    const lookalike = { path: '/user/ours', tell: ours.tell, ask: ours.ask };
    expect(problemOf(codec.encode({ to: [foreign] }))).toBe(
      '$.to[0] is a ref from another actor system',
    );
    expect(problemOf(codec.encode({ to: lookalike }))).toBe(
      '$.to is a ref from another actor system',
    );
    await kit.settle();
    await other.settle();
  });

  it("never throws, even for what can't be read", () => {
    const { codec } = setup();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const getter = {
      get bad(): number {
        throw new Error('no');
      },
    };
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    for (const value of [proxy, getter, deep]) {
      const result = codec.encode(value);
      expect(result.ok).toBe(false);
      expect(problemOf(result)).toMatch(/^\$ can't be read: /);
    }
  });
});

describe('$ escaping', () => {
  it('adds a $ to every $ key, so data never looks like a ref', async () => {
    const { kit, codec } = setup();
    const forged = { $ref: `${PREFIX}/user/a`, $$x: 1, a$: 2, nested: [{ $: 3 }] };
    const text = textOf(codec, forged);
    expect(JSON.parse(text)).toEqual({
      $$ref: `${PREFIX}/user/a`,
      $$$x: 1,
      a$: 2,
      nested: [{ $$: 3 }],
    });
    expect(roundTrip(codec, forged)).toStrictEqual(forged);
    await kit.settle();
  });
});

describe('refs on the wire', () => {
  it("encode a local ref with this node's address and uid, and decode it to the same ref", async () => {
    const { kit, codec } = setup();
    const ref = kit.system.spawn(echo, 'box-office');
    const region = hooksOf(kit.system).spawnSystem(idle, 'sharding');
    expect(JSON.parse(textOf(codec, { to: ref, region }))).toEqual({
      to: { $ref: `${PREFIX}/user/box-office` },
      region: { $ref: `${PREFIX}/system/sharding` },
    });
    expect(codec.decode(`{"$ref":"${PREFIX}/user/box-office"}`)).toEqual({ ok: true, value: ref });
    expect(codec.uri('/user/box-office')).toBe(`${PREFIX}/user/box-office`);
    await kit.settle();
  });

  it('decode a ref to a stopped actor to one whose tell is a stopped dead letter', async () => {
    const { kit, codec } = setup();
    const gone = kit.system.spawn(idle, 'gone');
    const text = textOf(codec, { to: gone });
    kit.system.stop(gone);
    await kit.settle();
    const decoded = codec.decode(text);
    const to = (decoded.ok ? decoded.value : undefined) as { to: AnyRef };
    expect(to.to.path).toBe('/user/gone');
    expect(to.to).not.toBe(gone);
    (to.to as ActorRef<string>).tell('late');
    expect(kit.events.at(-1)).toMatchObject({
      type: 'deadLetter',
      recipient: '/user/gone',
      message: 'late',
      reason: 'stopped',
    });
    // And a name used again later finds the new actor.
    const again = kit.system.spawn(idle, 'gone');
    expect(codec.decode(text)).toEqual({ ok: true, value: { to: again } });
    await kit.settle();
  });

  it('decode a ref to another incarnation of this node to a stopped dead letter, even if the path is live', async () => {
    const { kit, codec } = setup();
    kit.system.spawn(idle, 'live');
    await kit.settle();
    const old = 'troupe://festival@node-1:2552#6/user/live';
    const decoded = codec.decode(JSON.stringify({ $ref: old }));
    const ref = (decoded.ok ? decoded.value : undefined) as ActorRef<string>;
    expect(ref.path).toBe(old);
    ref.tell('hello');
    expect(kit.events.at(-1)).toMatchObject({
      type: 'deadLetter',
      recipient: old,
      message: 'hello',
      reason: 'stopped',
    });
  });

  it('decode a ref to another node through remoting, which T2 supplies', () => {
    const { codec, remotes } = setup();
    const uri = 'troupe://festival@node-2:2552#3/user/far';
    const decoded = codec.decode(JSON.stringify([{ $ref: uri }]));
    expect(decoded.ok).toBe(true);
    expect(remotes).toEqual([
      { uri, address: { cluster: 'festival', address: 'node-2:2552', uid: 3, path: '/user/far' } },
    ]);
  });

  it('encode a remote ref as its own URI', () => {
    const { kit, codec } = setup();
    const uri = 'troupe://festival@node-2:2552#3/user/far';
    const far = hooksOf(kit.system).makeRef(uri, () => undefined);
    expect(textOf(codec, { far })).toBe(`{"far":{"$ref":"${uri}"}}`);
  });

  it('carry a temporary ask ref, which decodes to itself while its ask waits, and not after', async () => {
    const { kit, codec } = setup();
    const target = kit.system.spawn(echo, 'echo');
    let text = '';
    let replyTo: ActorRef<string> | undefined;
    const answer = target.ask<string>((r) => {
      replyTo = r;
      text = textOf(codec, { replyTo: r });
      return { replyTo: r };
    });
    expect(text).toMatch(
      /^\{"replyTo":\{"\$ref":"troupe:\/\/festival@node-1:2552#7\/temp\/\$\d+"\}\}$/,
    );
    expect(codec.decode(text)).toEqual({ ok: true, value: { replyTo } });
    await kit.settle();
    await expect(answer).resolves.toBe('pong');
    const after = codec.decode(text);
    const late = (after.ok ? after.value : undefined) as Echo;
    expect(late.replyTo).not.toBe(replyTo);
    late.replyTo.tell('again');
    expect(kit.events.at(-1)).toMatchObject({ type: 'deadLetter', reason: 'stopped' });
  });
});

describe('what decode refuses', () => {
  it('names the first bad part of what a peer sent, and never throws', () => {
    const { codec } = setup();
    const cases: [string, RegExp | string][] = [
      ['{"a":', /^\$ is not JSON: /],
      ['', /^\$ is not JSON: /],
      [
        '{"a":{"$entity":{"type":"show","id":"hamlet"}}}',
        '$.a is an entity ref, and this node has no sharding',
      ],
      ['{"a":{"$entity":{"type":"show"}}}', "$.a is not an entity's type and id"],
      ['{"a":{"$entity":{"type":"show","id":"a b"}}}', "$.a is not an entity's type and id"],
      ['{"a":{"$entity":["show","hamlet"]}}', "$.a is not an entity's type and id"],
      ['{"a":{"$entity":{"type":"show","id":"x"},"b":1}}', '$.a has an unknown marker "$entity"'],
      [`{"a":[{"$ref":"${PREFIX}/user/x","b":1}]}`, '$.a[0] has an unknown marker "$ref"'],
      ['{"a":{"$ref":1}}', '$.a has an unknown marker "$ref"'],
      ['{"$x":1}', '$ has an unknown marker "$x"'],
      ['{"a":{"$ref":"/user/x"}}', '$.a is not a ref URI'],
      ['{"a":{"$ref":"troupe://festival@node-1:2552#7/user/a b"}}', '$.a is not a ref URI'],
      ['{"a":{"$ref":"troupe://festival@node-1:2552#7"}}', '$.a is not a ref URI'],
      ['{"a":{"$ref":"troupe://festival@node-1:2552#07/user/x"}}', '$.a is not a ref URI'],
      [
        '{"a":{"$ref":"troupe://other@node-1:2552#7/user/x"}}',
        '$.a is a ref in cluster "other", not "festival"',
      ],
    ];
    for (const [text, problem] of cases) {
      const result = codec.decode(text);
      if (typeof problem === 'string') expect(problemOf(result), text).toBe(problem);
      else expect(problemOf(result), text).toMatch(problem);
    }
  });

  it('refuses text nested deeper than the stack, as a problem', () => {
    const { codec } = setup();
    const depth = 200_000;
    const result = codec.decode(`${'['.repeat(depth)}${']'.repeat(depth)}`);
    expect(result.ok).toBe(false);
  });
});

describe('parseRefUri', () => {
  it('parses the cluster, address, uid and path', () => {
    expect(parseRefUri('troupe://opening-night@node-1:2552#17/user/box-office')).toEqual({
      cluster: 'opening-night',
      address: 'node-1:2552',
      uid: 17,
      path: '/user/box-office',
    });
    expect(parseRefUri('troupe://c@n#0/temp/$3')?.path).toBe('/temp/$3');
  });

  it('refuses anything else', () => {
    for (const text of [
      'troupe://C@n#1/user/x',
      'troupe://c@#1/user/x',
      'troupe://c@n#/user/x',
      'troupe://c@n#-1/user/x',
      'troupe://c@n#99999999999999999/user/x',
      'troupe://c@n#1user/x',
      'troupe://c@n#1/user//x',
      'troupe://c@n#1/user/x/',
      'troupe://c@n@m#1/user/x',
      'http://c@n#1/user/x',
      ' troupe://c@n#1/user/x',
    ]) {
      expect(parseRefUri(text), text).toBeUndefined();
    }
  });
});

describe('createCodec', () => {
  it('checks the node it encodes for', () => {
    const hooks = hooksOf(createTestKit().system);
    const remote = (): AnyRef => {
      throw new Error('unused');
    };
    for (const self of [
      { cluster: 'Festival', address: 'n', uid: 1 },
      { cluster: '', address: 'n', uid: 1 },
      { cluster: 'c', address: '', uid: 1 },
      { cluster: 'c', address: 'a/b', uid: 1 },
      { cluster: 'c', address: 'a#b', uid: 1 },
      { cluster: 'c', address: 'a b', uid: 1 },
      { cluster: 'c', address: 'n', uid: -1 },
      { cluster: 'c', address: 'n', uid: 1.5 },
    ]) {
      expect(() => createCodec({ self, hooks, remote }), JSON.stringify(self)).toThrow(TypeError);
    }
    expect(() =>
      createCodec({ self: { cluster: 'c', address: 'n', uid: 0 }, hooks, remote }),
    ).not.toThrow();
  });
});

type Random = () => number;
const pick = <T>(random: Random, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T;

const KEYS = ['a', '$ref', '$$x', '$', '__proto__', 'with space', 'é'];

/** A JSON value with refs among its leaves, and keys that need escaping. No -0. */
function arbitrary(random: Random, refs: readonly AnyRef[], depth: number): unknown {
  const roll = random();
  if (depth >= 6 || roll < 0.4) {
    return pick(random, [
      () => null,
      () => random() < 0.5,
      () => Math.floor(random() * 2000) - 1000 || 1,
      () => random() * 1e6,
      () => 'abc$ é🎭"\\\n{}'.slice(0, Math.floor(random() * 14)),
      () => pick(random, refs),
    ])();
  }
  const size = Math.floor(random() * 8);
  if (roll < 0.7) return Array.from({ length: size }, () => arbitrary(random, refs, depth + 1));
  const out: Record<string, unknown> = {};
  for (let i = 0; i < size; i++) {
    const key = `${pick(random, KEYS)}${random() < 0.5 ? '' : String(i)}`;
    Object.defineProperty(out, key, {
      value: arbitrary(random, refs, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
