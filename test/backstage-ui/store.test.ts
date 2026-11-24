import {
  backstage,
  type ActorInfo,
  type ClusterInfo,
  type Frame,
  type MemberInfo,
  type WireEvent,
} from '@kylewillett/troupe/backstage';
import { describe, expect, it } from 'vitest';
import {
  createStore,
  DEPTH_WINDOW_MS,
  FADE_MS,
  FAILURES_PER_ACTOR,
  FLOW_MS,
  MESSAGES_PER_ACTOR,
  MOVE_MS,
  PENDING,
  type ActorView,
  type BackstageStore,
  type HelloV1,
} from '../../backstage/src/store/store.ts';
import { testNight } from '../demo/helpers.ts';

// Frames by hand, so each test says exactly what the store saw.
let seq = 0;
type Fields<T extends WireEvent['type']> = Omit<Extract<WireEvent, { type: T }>, 'seq' | 'type'>;
const ev = <T extends WireEvent['type']>(type: T, fields: Fields<T>): Frame =>
  ({ type: 'event', event: { seq: ++seq, type, ...fields } }) as unknown as Frame;

const hello = (
  actors: readonly ActorInfo[] = [],
  opts: {
    now?: number;
    history?: readonly WireEvent[];
    system?: string;
    cluster?: ClusterInfo | null;
  } = {},
): Frame => ({
  type: 'hello',
  protocol: 2,
  system: opts.system ?? 'opening-night',
  now: opts.now ?? 0,
  actors,
  history: opts.history ?? [],
  cluster: opts.cluster ?? null,
});

const running = (path: string, more: Partial<ActorInfo> = {}): ActorInfo => ({
  path,
  status: 'running',
  depth: 0,
  ...more,
});

const SHOW = '/user/box-office/hamlet';
const OFFICE = '/user/box-office';
const CUSTOMER = '/user/crowd/customer-1';

function connected(actors: readonly ActorInfo[] = [running(OFFICE), running(SHOW)]) {
  const store = createStore();
  store.apply(hello(actors));
  return store;
}

const actor = (store: BackstageStore, path: string): ActorView => {
  const found = store.view().actors.find((a) => a.path === path);
  if (found === undefined) throw new Error(`no actor at ${path}`);
  return found;
};
const paths = (store: BackstageStore) => store.view().actors.map((a) => a.path);

describe('the Backstage store', () => {
  it('shows nothing until a hello', () => {
    const store = createStore();
    expect(store.view()).toMatchObject({ connected: false, actors: [], connection: 0 });
    store.apply(ev('spawned', { at: 1, path: SHOW }));
    expect(store.view().actors).toEqual([]);
  });

  describe('a hello', () => {
    it('lists every actor under /user, each parent before its children', () => {
      const store = createStore();
      store.apply(
        hello(
          [
            running('/user'),
            running(OFFICE),
            running(SHOW, { status: 'starting', depth: 2, persistenceId: 'show-hamlet' }),
            running('/user/crowd'),
            running(CUSTOMER),
          ],
          { now: 500 },
        ),
      );
      const view = store.view();
      expect(view).toMatchObject({
        connected: true,
        system: 'opening-night',
        now: 500,
        connection: 1,
      });
      expect(view.actors.map((a) => [a.path, a.level, a.parent, a.name])).toEqual([
        [OFFICE, 0, undefined, 'box-office'],
        [SHOW, 1, OFFICE, 'hamlet'],
        ['/user/crowd', 0, undefined, 'crowd'],
        [CUSTOMER, 1, '/user/crowd', 'customer-1'],
      ]);
      expect(actor(store, SHOW)).toMatchObject({
        phase: 'starting',
        depth: 2,
        persistenceId: 'show-hamlet',
        depths: [{ at: 500, depth: 2, peak: 2 }],
      });
    });

    it('takes past failures and writes from its history, but where each actor is from the list', () => {
      const store = createStore();
      const history: WireEvent[] = [
        { seq: 1, at: 10, type: 'spawned', path: SHOW },
        {
          seq: 2,
          at: 20,
          type: 'failed',
          path: SHOW,
          error: { $error: { name: 'RangeError', message: 'bad' } },
          directive: 'restart',
        },
        { seq: 3, at: 220, type: 'restarted', path: SHOW, attempt: 1, delayMs: 200 },
        {
          seq: 4,
          at: 230,
          type: 'persisted',
          path: SHOW,
          persistenceId: 'show-hamlet',
          fromSeq: 1,
          toSeq: 4,
        },
        // About an actor that has gone: nothing to show.
        { seq: 5, at: 240, type: 'failed', path: CUSTOMER, error: 'x', directive: 'stop' },
      ];
      store.apply(hello([running(SHOW)], { now: 300, history }));
      expect(paths(store)).toEqual([SHOW]);
      expect(actor(store, SHOW)).toMatchObject({
        phase: 'running',
        lastSeq: 4,
        persistenceId: 'show-hamlet',
        failures: [
          {
            at: 20,
            directive: 'restart',
            error: { $error: { name: 'RangeError', message: 'bad' } },
            restart: { at: 220, attempt: 1, delayMs: 200 },
          },
        ],
      });
      // Totals count from the hello on.
      expect(store.view().totals).toMatchObject({ failures: 0, restarts: 0 });
    });

    it('starts over after a reconnect, or a new system', () => {
      const store = connected();
      store.apply(ev('spawned', { at: 5, path: CUSTOMER }));
      store.apply(ev('delivered', { at: 6, path: SHOW, id: 1, message: 'm', depth: 1 }));
      expect(store.view().totals.delivered).toBe(1);

      store.apply(hello([running('/user/crowd')], { now: 50, system: 'again' }));
      const view = store.view();
      expect(view).toMatchObject({ connection: 2, system: 'again', now: 50 });
      expect(paths(store)).toEqual(['/user/crowd']);
      expect(view.totals.delivered).toBe(0);
      // The old connection's message never ends here.
      store.apply(
        ev('processed', { at: 60, path: SHOW, id: 1, durationMs: 0, depth: 0, stateChanged: true }),
      );
      expect(store.view().totals.processed).toBe(1);
      expect(paths(store)).toEqual(['/user/crowd']);
    });
  });

  describe('the tree', () => {
    it('shows an actor the hello listed as starting running once it does something', () => {
      const store = connected([
        running(OFFICE, { status: 'starting' }),
        running('/user/crowd', { status: 'starting' }),
        running(SHOW, { status: 'starting', persistenceId: 'show-hamlet' }),
      ]);
      store.apply(ev('spawned', { at: 1, path: CUSTOMER }));
      store.apply(ev('delivered', { at: 1, path: OFFICE, id: 1, message: 'm', depth: 1 }));
      store.apply(
        ev('processed', {
          at: 1,
          path: OFFICE,
          id: 1,
          durationMs: 0,
          depth: 0,
          stateChanged: false,
        }),
      );
      store.apply(ev('delivered', { at: 1, path: SHOW, id: 2, message: 'm', depth: 1 }));
      store.apply(
        ev('processed', { at: 1, path: SHOW, id: 2, durationMs: 0, depth: 0, stateChanged: false }),
      );
      expect(actor(store, OFFICE).phase).toBe('running');
      expect(actor(store, '/user/crowd').phase).toBe('running');
      // A persistent actor is running once it has recovered, which says so.
      expect(actor(store, SHOW).phase).toBe('starting');
    });

    it('adds spawned actors under their parents, in spawn order', () => {
      const store = connected([running('/user/crowd')]);
      store.apply(ev('spawned', { at: 1, path: '/user/crowd/customer-2' }));
      store.apply(ev('spawned', { at: 2, path: '/user/sales-board' }));
      store.apply(ev('spawned', { at: 3, path: CUSTOMER }));
      store.apply(ev('spawned', { at: 4, path: '/temp/ask-1' }));
      expect(paths(store)).toEqual([
        '/user/crowd',
        '/user/crowd/customer-2',
        CUSTOMER,
        '/user/sales-board',
      ]);
      expect(actor(store, CUSTOMER)).toMatchObject({ phase: 'running', depth: 0 });
    });

    it('fades a stopped actor out, then drops it', () => {
      const store = connected([running('/user/crowd')]);
      store.apply(ev('spawned', { at: 0, path: CUSTOMER }));
      store.apply(ev('stopped', { at: 100, path: CUSTOMER }));
      expect(actor(store, CUSTOMER)).toMatchObject({ phase: 'stopped', stoppedAt: 100 });
      store.apply(ev('spawned', { at: 100 + FADE_MS - 1, path: '/user/crowd/customer-2' }));
      expect(paths(store)).toContain(CUSTOMER);
      store.apply(ev('spawned', { at: 100 + FADE_MS, path: '/user/crowd/customer-3' }));
      expect(paths(store)).toEqual([
        '/user/crowd',
        '/user/crowd/customer-2',
        '/user/crowd/customer-3',
      ]);
    });

    it('replaces a fading actor when its name is used again', () => {
      const store = connected([running('/user/crowd')]);
      store.apply(ev('spawned', { at: 0, path: CUSTOMER }));
      store.apply(ev('stopped', { at: 10, path: CUSTOMER }));
      store.apply(ev('spawned', { at: 20, path: CUSTOMER }));
      expect(paths(store)).toEqual(['/user/crowd', CUSTOMER]);
      expect(actor(store, CUSTOMER).phase).toBe('running');
    });

    it('follows a failure, the restart and the recovery', () => {
      const store = connected([running(SHOW, { persistenceId: 'show-hamlet' })]);
      const error = { $error: { name: 'RangeError', message: 'seats' } };
      store.apply(ev('delivered', { at: 1, path: SHOW, id: 7, message: { seats: -1 }, depth: 1 }));
      store.apply(
        ev('processed', { at: 1, path: SHOW, id: 7, durationMs: 0, depth: 0, stateChanged: false }),
      );
      store.apply(ev('failed', { at: 1, path: SHOW, error, directive: 'restart' }));
      expect(actor(store, SHOW).phase).toBe('restarting');
      expect(actor(store, SHOW).messages.at(-1)?.outcome).toBe('failed');

      store.apply(ev('restarted', { at: 201, path: SHOW, attempt: 1, delayMs: 200 }));
      expect(actor(store, SHOW).phase).toBe('starting');
      store.apply(
        ev('recovered', {
          at: 202,
          path: SHOW,
          persistenceId: 'show-hamlet',
          snapshotSeq: 0,
          lastSeq: 9,
        }),
      );
      expect(actor(store, SHOW)).toMatchObject({
        phase: 'running',
        lastSeq: 9,
        failures: [
          { at: 1, error, directive: 'restart', restart: { at: 201, attempt: 1, delayMs: 200 } },
        ],
      });
    });

    it('shows a plain actor running again at once after a restart, and one stopping', () => {
      const store = connected([running(OFFICE), running('/user/crowd')]);
      store.apply(ev('failed', { at: 1, path: OFFICE, error: 'x', directive: 'restart' }));
      store.apply(ev('restarted', { at: 1, path: OFFICE, attempt: 1, delayMs: 0 }));
      store.apply(ev('failed', { at: 2, path: '/user/crowd', error: 'y', directive: 'stop' }));
      expect(actor(store, OFFICE).phase).toBe('running');
      expect(actor(store, '/user/crowd').phase).toBe('stopping');
      store.apply(ev('failed', { at: 3, path: OFFICE, error: 'z', directive: 'resume' }));
      expect(actor(store, OFFICE).phase).toBe('running');
    });
  });

  describe('messages', () => {
    it('follows each message from its delivery to its end, with depths', () => {
      const store = connected();
      store.apply(
        ev('delivered', {
          at: 10,
          path: SHOW,
          id: 1,
          from: OFFICE,
          message: { type: 'hold' },
          depth: 1,
        }),
      );
      store.apply(
        ev('delivered', { at: 12, path: SHOW, id: 2, message: { type: 'expire' }, depth: 2 }),
      );
      expect(actor(store, SHOW)).toMatchObject({ depth: 2, peakDepth: 2 });
      expect(actor(store, SHOW).messages.map((m) => m.outcome)).toEqual(['waiting', 'waiting']);

      // Taken at 15, written by 18.
      store.apply(
        ev('processed', { at: 18, path: SHOW, id: 1, durationMs: 3, depth: 1, stateChanged: true }),
      );
      store.apply(
        ev('processed', {
          at: 18,
          path: SHOW,
          id: 2,
          durationMs: 0,
          depth: 0,
          stateChanged: false,
          skipped: true,
        }),
      );
      const show = actor(store, SHOW);
      expect(show.messages).toEqual([
        {
          id: 1,
          from: OFFICE,
          message: { type: 'hold' },
          deliveredAt: 10,
          depth: 1,
          outcome: 'processed',
          waitedMs: 5,
          handledMs: 3,
        },
        {
          id: 2,
          message: { type: 'expire' },
          deliveredAt: 12,
          depth: 2,
          outcome: 'skipped',
          waitedMs: 6,
          handledMs: 0,
        },
      ]);
      // Two samples at 18 are one, which keeps that ms's peak.
      expect(show.depths).toEqual([
        { at: 0, depth: 0, peak: 0 },
        { at: 10, depth: 1, peak: 1 },
        { at: 12, depth: 2, peak: 2 },
        { at: 18, depth: 0, peak: 1 },
      ]);
      expect(show).toMatchObject({ depth: 0, stateVersion: 1 });
      expect(store.view().totals).toMatchObject({ delivered: 2, processed: 2 });
    });

    it('marks a message a stop drained as dropped, and counts every dead letter', () => {
      const store = connected();
      store.apply(ev('delivered', { at: 1, path: SHOW, id: 3, message: 'm', depth: 1 }));
      store.apply(
        ev('deadLetter', { at: 2, recipient: SHOW, message: 'm', id: 3, reason: 'stopped' }),
      );
      store.apply(ev('deadLetter', { at: 2, recipient: SHOW, message: 'late', reason: 'stopped' }));
      expect(actor(store, SHOW).messages).toMatchObject([
        { id: 3, outcome: 'dropped', reason: 'stopped' },
      ]);
      expect(store.view().totals.deadLetters).toBe(2);
    });

    it('ignores the end of a message it never saw delivered, and messages to unknown actors', () => {
      const store = connected();
      store.apply(
        ev('processed', {
          at: 1,
          path: SHOW,
          id: 99,
          durationMs: 0,
          depth: 0,
          stateChanged: false,
        }),
      );
      store.apply(
        ev('deadLetter', { at: 1, recipient: SHOW, message: 'x', id: 98, reason: 'stopped' }),
      );
      store.apply(
        ev('delivered', {
          at: 1,
          path: '/temp/ask-1',
          id: 4,
          from: SHOW,
          message: 'reply',
          depth: 1,
        }),
      );
      expect(actor(store, SHOW).messages).toEqual([]);
      expect(store.view().flows).toEqual([]);
    });

    it('links sender and receiver for a while, when both are in the tree', () => {
      const store = connected();
      store.apply(
        ev('delivered', { at: 100, path: SHOW, id: 1, from: OFFICE, message: 'a', depth: 1 }),
      );
      store.apply(ev('delivered', { at: 110, path: OFFICE, id: 2, message: 'b', depth: 1 }));
      expect(store.view().flows).toEqual([{ id: 1, from: OFFICE, to: SHOW, at: 100 }]);
      store.apply(
        ev('delivered', { at: 100 + FLOW_MS, path: OFFICE, id: 3, message: 'c', depth: 2 }),
      );
      expect(store.view().flows).toHaveLength(1);
      store.apply(
        ev('delivered', { at: 101 + FLOW_MS, path: OFFICE, id: 4, message: 'd', depth: 3 }),
      );
      expect(store.view().flows).toEqual([]);
    });
  });

  it('keeps the peak of a ms in which messages came and went', () => {
    const store = connected();
    for (let id = 1; id <= 5; id++) {
      store.apply(ev('delivered', { at: 7, path: SHOW, id, message: id, depth: id }));
    }
    for (let id = 1; id <= 5; id++) {
      store.apply(
        ev('processed', {
          at: 7,
          path: SHOW,
          id,
          durationMs: 0,
          depth: 5 - id,
          stateChanged: false,
        }),
      );
    }
    expect(actor(store, SHOW)).toMatchObject({
      depth: 0,
      peakDepth: 5,
      depths: [
        { at: 0, depth: 0, peak: 0 },
        { at: 7, depth: 0, peak: 5 },
      ],
    });
  });

  describe('bounded history', () => {
    it(`keeps the last ${String(MESSAGES_PER_ACTOR)} messages per actor`, () => {
      const store = connected();
      for (let id = 1; id <= MESSAGES_PER_ACTOR + 50; id++) {
        store.apply(ev('delivered', { at: id, path: SHOW, id, message: id, depth: 1 }));
        store.apply(
          ev('processed', { at: id, path: SHOW, id, durationMs: 0, depth: 0, stateChanged: false }),
        );
      }
      const { messages } = actor(store, SHOW);
      expect(messages).toHaveLength(MESSAGES_PER_ACTOR);
      expect(messages[0]?.id).toBe(51);
      expect(messages.every((m) => m.outcome === 'processed')).toBe(true);
    });

    it('lets a message pushed out of the ring still end, without bringing it back', () => {
      const store = connected();
      store.apply(ev('delivered', { at: 0, path: SHOW, id: 1, message: 'first', depth: 1 }));
      for (let id = 2; id <= MESSAGES_PER_ACTOR + 1; id++) {
        store.apply(ev('delivered', { at: 0, path: SHOW, id, message: id, depth: id }));
      }
      store.apply(
        ev('processed', { at: 1, path: SHOW, id: 1, durationMs: 0, depth: 0, stateChanged: false }),
      );
      const { messages } = actor(store, SHOW);
      expect(messages).toHaveLength(MESSAGES_PER_ACTOR);
      expect(messages.some((m) => m.id === 1)).toBe(false);
    });

    it(`gives up on a message after ${String(PENDING)} others are waiting`, () => {
      const store = connected();
      for (let id = 1; id <= PENDING + 1; id++) {
        store.apply(ev('delivered', { at: 0, path: SHOW, id, message: id, depth: id }));
      }
      // Too many still waiting: the oldest is forgotten, so its end changes nothing, and the
      // newest still ends.
      const before = actor(store, SHOW);
      store.apply(
        ev('processed', { at: 1, path: SHOW, id: 1, durationMs: 0, depth: 0, stateChanged: false }),
      );
      store.apply(
        ev('processed', {
          at: 1,
          path: SHOW,
          id: PENDING + 1,
          durationMs: 0,
          depth: 0,
          stateChanged: false,
        }),
      );
      const after = actor(store, SHOW);
      expect(before.messages.at(-1)?.outcome).toBe('waiting');
      expect(after.messages.at(-1)?.outcome).toBe('processed');
    });

    it(`keeps ${String(DEPTH_WINDOW_MS / 1_000)} s of depth samples`, () => {
      const store = connected();
      for (let at = 0; at <= 90_000; at += 1_000) {
        store.apply(ev('delivered', { at, path: SHOW, id: at, message: 'm', depth: 1 }));
        store.apply(
          ev('processed', { at, path: SHOW, id: at, durationMs: 0, depth: 0, stateChanged: false }),
        );
      }
      const { depths } = actor(store, SHOW);
      // The last sample before the window starts stays, so the chart knows where it began.
      expect(depths[0]?.at).toBe(30_000);
      expect(depths.at(-1)?.at).toBe(90_000);
      expect(depths.length).toBeLessThanOrEqual(62);
    });

    it(`keeps the last ${String(FAILURES_PER_ACTOR)} failures per actor`, () => {
      const store = connected();
      for (let at = 0; at < FAILURES_PER_ACTOR + 5; at++) {
        store.apply(ev('failed', { at, path: SHOW, error: at, directive: 'resume' }));
      }
      const { failures } = actor(store, SHOW);
      expect(failures).toHaveLength(FAILURES_PER_ACTOR);
      expect(failures[0]?.error).toBe(5);
    });
  });

  describe('a cluster', () => {
    const member = (address: string, uid: number, more: Partial<MemberInfo> = {}): MemberInfo => ({
      address,
      uid,
      status: 'up',
      reachable: true,
      ...more,
    });
    const N1 = 'node-1#11';
    const N2 = 'node-2#22';
    const N3 = 'node-3#33';
    const info = (
      owners: Record<number, string>,
      members: readonly MemberInfo[] = [
        member('node-1', 11),
        member('node-2', 22),
        member('node-3', 33),
      ],
    ): ClusterInfo => ({
      address: 'node-1',
      uid: 11,
      members,
      types: [
        {
          type: 'show',
          shardCount: 4,
          host: true,
          shards: Object.entries(owners).map(([shard, owner]) => ({ shard: Number(shard), owner })),
        },
      ],
    });
    const clusterFrame = (cluster: ClusterInfo): Frame => ({ type: 'cluster', cluster });
    const owners = (store: BackstageStore) =>
      store.view().cluster?.types[0]?.shards.map((s) => s.owner ?? null);

    it('reads a version 1 hello as a system with no cluster', () => {
      const store = createStore();
      const v1: HelloV1 = {
        type: 'hello',
        protocol: 1,
        system: 'opening-night',
        now: 5,
        actors: [running(OFFICE), running(SHOW)],
        history: [],
      };
      store.apply(v1);
      expect(store.view()).toMatchObject({ connected: true, cluster: null, now: 5 });
      expect(paths(store)).toEqual([OFFICE, SHOW]);
    });

    it('shows the members, which one it is, and every shard with the owner it knows', () => {
      const store = createStore();
      store.apply(hello([], { cluster: info({ 0: N1, 2: N3 }) }));
      const { cluster } = store.view();
      expect(cluster?.self).toBe(N1);
      expect(cluster?.members.map((m) => [m.key, m.self, m.status, m.reachable])).toEqual([
        [N1, true, 'up', true],
        [N2, false, 'up', true],
        [N3, false, 'up', true],
      ]);
      expect(cluster?.types[0]).toMatchObject({ type: 'show', shardCount: 4, host: true });
      // Every shard, owned or not, and none marked as moved on a hello.
      expect(cluster?.types[0]?.shards).toEqual([
        { shard: 0, owner: N1 },
        { shard: 1 },
        { shard: 2, owner: N3 },
        { shard: 3 },
      ]);
    });

    it('follows reachability and status from cluster frames', () => {
      const store = createStore();
      store.apply(hello([], { cluster: info({}) }));
      store.apply(
        clusterFrame(
          info({}, [
            member('node-1', 11),
            member('node-2', 22, { reachable: false }),
            member('node-3', 33),
          ]),
        ),
      );
      expect(store.view().cluster?.members[1]).toMatchObject({ key: N2, reachable: false });
      store.apply(
        clusterFrame(
          info({}, [
            member('node-1', 11),
            member('node-2', 22, { status: 'down', reachable: false }),
            member('node-3', 33, { status: 'leaving' }),
          ]),
        ),
      );
      expect(store.view().cluster?.members.map((m) => m.status)).toEqual(['up', 'down', 'leaving']);
    });

    it('marks a shard that changed owner for MOVE_MS, with where it came from', () => {
      const store = createStore();
      store.apply(hello([running(OFFICE)], { cluster: info({ 0: N1, 1: N2 }) }));
      store.apply(
        ev('processed', {
          at: 100,
          path: OFFICE,
          id: 1,
          durationMs: 0,
          depth: 0,
          stateChanged: false,
        }),
      );
      // node-2 goes, and its shard comes to node-3. Shard 2 gets its first owner.
      store.apply(clusterFrame(info({ 0: N1 })));
      store.apply(clusterFrame(info({ 0: N1, 1: N3, 2: N1 })));
      const shards = store.view().cluster?.types[0]?.shards;
      expect(shards?.[0]).toEqual({ shard: 0, owner: N1 });
      // Its last change was from no owner to node-3: it was node-2's one frame before.
      expect(shards?.[1]).toEqual({ shard: 1, owner: N3, movedAt: 100 });
      expect(shards?.[2]).toEqual({ shard: 2, owner: N1, movedAt: 100 });
      expect(owners(store)).toEqual([N1, N3, N1, null]);

      // Still marked just before MOVE_MS, and not at it.
      const at = (t: number) =>
        ev('processed', {
          at: t,
          path: OFFICE,
          id: t,
          durationMs: 0,
          depth: 0,
          stateChanged: false,
        });
      store.apply(at(100 + MOVE_MS - 1));
      expect(store.view().cluster?.types[0]?.shards[1]?.movedAt).toBe(100);
      store.apply(at(100 + MOVE_MS));
      expect(store.view().cluster?.types[0]?.shards[1]).toEqual({ shard: 1, owner: N3 });
    });

    it('says where a shard moved from when it goes straight from one owner to another', () => {
      const store = createStore();
      store.apply(hello([], { now: 7, cluster: info({ 3: N2 }) }));
      store.apply(clusterFrame(info({ 3: N3 })));
      expect(store.view().cluster?.types[0]?.shards[3]).toEqual({
        shard: 3,
        owner: N3,
        movedAt: 7,
        movedFrom: N2,
      });
      // A new hello starts over: nothing it shows has moved.
      store.apply(hello([], { now: 8, cluster: info({ 3: N3 }) }));
      expect(store.view().cluster?.types[0]?.shards[3]).toEqual({ shard: 3, owner: N3 });
    });

    it('ignores a cluster frame before the hello, and keeps the view while nothing changes', () => {
      const store = createStore();
      store.apply(clusterFrame(info({ 0: N1 })));
      expect(store.view().cluster).toBeNull();
      store.apply(hello([], { cluster: info({ 0: N1 }) }));
      const first = store.view().cluster;
      store.apply(ev('spawned', { at: 1, path: '/user/x' }));
      expect(store.view().cluster).toBe(first);
    });

    it('shows the sharding tree above /user, and nothing else under /system', () => {
      const REGION = '/system/sharding/show';
      const SHARD = `${REGION}/3`;
      const ENTITY = `${SHARD}/hamlet`;
      const store = createStore();
      store.apply(
        hello(
          [
            running('/user/crowd'),
            running('/system/sharding'),
            running(REGION),
            running(SHARD),
            running(ENTITY, { persistenceId: 'show-hamlet' }),
            running('/system/remoting'),
          ],
          { cluster: info({ 3: N1 }) },
        ),
      );
      const view = store.view();
      expect(view.actors.map((a) => [a.path, a.section, a.level, a.parent, a.name])).toEqual([
        [REGION, 'sharding', 0, undefined, 'show'],
        [SHARD, 'sharding', 1, REGION, '3'],
        [ENTITY, 'sharding', 2, SHARD, 'hamlet'],
        ['/user/crowd', 'user', 0, undefined, 'crowd'],
      ]);
      // An entity spawned later joins its shard; it stops and fades as any actor does.
      store.apply(ev('spawned', { at: 2, path: `${SHARD}/lear` }));
      expect(paths(store)).toEqual([REGION, SHARD, ENTITY, `${SHARD}/lear`, '/user/crowd']);
      store.apply(ev('stopped', { at: 3, path: ENTITY }));
      expect(actor(store, ENTITY).phase).toBe('stopped');
    });
  });

  describe('the view', () => {
    it('is the same object until a frame changes something', () => {
      const store = connected();
      const first = store.view();
      expect(store.view()).toBe(first);
      store.apply(ev('delivered', { at: 1, path: SHOW, id: 1, message: 'm', depth: 1 }));
      expect(store.view()).not.toBe(first);
    });

    it('keeps the objects of actors that did not change', () => {
      const store = connected();
      const before = store.view().actors;
      store.apply(ev('delivered', { at: 1, path: SHOW, id: 1, message: 'm', depth: 1 }));
      const after = store.view().actors;
      expect(after[0]).toBe(before[0]);
      expect(after[1]).not.toBe(before[1]);
    });
  });

  it('follows opening night, ending with the tree its hello would show', async () => {
    const { night } = testNight();
    const store = createStore();
    const source = backstage(night.system);
    source.connect((frame) => {
      store.apply(frame);
    });
    await night.rush();
    await night.badRequest();
    await night.clock.advance(5_000);

    // Live actors match a fresh connection's list. Stopped ones are still fading.
    const fresh: ActorInfo[] = [];
    source.connect((frame) => {
      if (frame.type === 'hello') fresh.push(...frame.actors);
    })();
    const live = store.view().actors.filter((a) => a.phase !== 'stopped');
    expect(live.map((a) => [a.path, a.phase, a.depth])).toEqual(
      fresh.filter((a) => a.path !== '/user').map((a) => [a.path, a.status, a.depth]),
    );
    const hamlet = actor(store, SHOW);
    expect(hamlet.failures).toHaveLength(1);
    expect(hamlet.failures[0]?.restart?.attempt).toBe(1);
    expect(hamlet.lastSeq).toBeGreaterThan(0);
    expect(hamlet.messages.filter((m) => m.outcome === 'waiting')).toEqual([]);
    const { totals } = store.view();
    expect(totals.delivered).toBeGreaterThan(100);
    source.close();
    await night.dispose();
  });
});
