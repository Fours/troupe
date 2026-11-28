// The UI's hold on a client: the store, published once per animation frame, and the requests the
// panels make. Requests are coalesced, so however fast an actor's state changes there is at most
// one request in flight for it, and the journal's history is cached, since it never changes.

import type {
  BackstageClient,
  BackstageRequest,
  BackstageResponse,
  TimelineEvent,
  WireValue,
} from '@kylewillett/troupe/backstage';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createStore, type ViewModel } from '../store/store.ts';

/**
 * Connects to `client` and returns the store's view, redrawn at most once per animation frame,
 * however many frames arrive in between.
 */
export function useBackstage(client: BackstageClient): ViewModel {
  const live = useMemo(() => {
    const store = createStore();
    let published = store.view();
    return {
      subscribe: (notify: () => void) => {
        let changed = false;
        let frame = 0;
        const disconnect = client.connect((f) => {
          store.apply(f);
          if (changed) return;
          changed = true;
          frame = requestAnimationFrame(() => {
            changed = false;
            published = store.view();
            notify();
          });
        });
        return () => {
          cancelAnimationFrame(frame);
          disconnect();
        };
      },
      snapshot: () => published,
    };
  }, [client]);
  return useSyncExternalStore(live.subscribe, live.snapshot);
}

/** What a request hook holds: the answer once it's in, or why there isn't one. */
export interface Answer<T> {
  readonly value?: T;
  readonly error?: string;
  /** Whether a newer request is still on its way. */
  readonly loading: boolean;
}

const errorText = (res: Extract<BackstageResponse, { ok: false }>): string =>
  `${res.error.name}: ${res.error.message}`;

/**
 * An actor's current state, asked for again whenever `version` changes, with at most one request
 * in flight: a change while one is out is asked for once it's back.
 */
export function useActorState(
  client: BackstageClient,
  path: string | undefined,
  version: number,
): Answer<WireValue> {
  const [answer, setAnswer] = useState<Answer<WireValue> & { path?: string }>({ loading: false });
  const gate = useMemo(() => ({ busy: false, again: false }), []);

  useEffect(() => {
    if (path === undefined) return;
    let cancelled = false;
    const ask = (): void => {
      if (gate.busy) {
        gate.again = true;
        return;
      }
      gate.busy = true;
      void client.request({ type: 'state', path }).then((res) => {
        gate.busy = false;
        if (!cancelled) {
          setAnswer(
            res.ok && res.type === 'state'
              ? { value: res.state, loading: false, path }
              : { error: res.ok ? 'unexpected answer' : errorText(res), loading: false, path },
          );
        }
        if (gate.again) {
          gate.again = false;
          if (!cancelled) ask();
        }
      });
    };
    ask();
    return () => {
      cancelled = true;
    };
  }, [client, path, version, gate]);

  // An answer about another actor is no answer.
  return answer.path === path ? answer : { loading: true };
}

/** A persistent actor's journal, as far as the UI has read it. */
interface History {
  readonly events: TimelineEvent[];
  /** Read from 1 up to here. */
  loaded: number;
  /** States after each event, by `seq`, from `stateAt`. */
  readonly states: Map<number, WireValue>;
}

// Per client and persistence id, for as long as the client lives. A restarted system writes to
// the same journal, so its history carries over.
const histories = new WeakMap<BackstageClient, Map<string, History>>();

function historyOf(client: BackstageClient, persistenceId: string): History {
  let byId = histories.get(client);
  if (byId === undefined) {
    byId = new Map();
    histories.set(client, byId);
  }
  let history = byId.get(persistenceId);
  if (history === undefined) {
    history = { events: [], loaded: 0, states: new Map() };
    byId.set(persistenceId, history);
  }
  return history;
}

/** The most events one `timeline` request may ask for. */
const PAGE = 256;

/**
 * A persistent actor's events, read page by page and then as `lastSeq` grows. The events already
 * read stay, so a journal that goes down only stops the reading.
 */
export function useTimeline(
  client: BackstageClient,
  path: string | undefined,
  persistenceId: string | undefined,
  lastSeq: number,
): Answer<readonly TimelineEvent[]> {
  const [answer, setAnswer] = useState<Answer<readonly TimelineEvent[]> & { id?: string }>({
    loading: false,
  });

  useEffect(() => {
    if (path === undefined || persistenceId === undefined) return;
    const history = historyOf(client, persistenceId);
    let cancelled = false;
    const show = (loading: boolean, error?: string) => {
      if (cancelled) return;
      setAnswer({
        value: [...history.events],
        loading,
        id: persistenceId,
        ...(error === undefined ? {} : { error }),
      });
    };
    const read = async (): Promise<void> => {
      while (!cancelled && history.loaded < lastSeq) {
        const req: BackstageRequest = {
          type: 'timeline',
          path,
          fromSeq: history.loaded + 1,
          limit: PAGE,
        };
        const res = await client.request(req);
        if (!res.ok) {
          show(false, errorText(res));
          return;
        }
        if (res.type !== 'timeline') return;
        // Another read of the same journal may have got here first.
        for (const event of res.events) {
          if (event.seq === history.loaded + 1) {
            history.events.push(event);
            history.loaded = event.seq;
          }
        }
        if (res.events.length === 0) break;
      }
      show(false);
    };
    show(history.loaded < lastSeq);
    void read();
    return () => {
      cancelled = true;
    };
  }, [client, path, persistenceId, lastSeq]);

  return answer.id === persistenceId ? answer : { loading: true };
}

/** A persistent actor's state after event `seq`, and after the one before, for the highlight. */
export function useStateAt(
  client: BackstageClient,
  path: string | undefined,
  persistenceId: string | undefined,
  seq: number | undefined,
): Answer<{ readonly before: WireValue; readonly after: WireValue }> {
  const [answer, setAnswer] = useState<
    Answer<{ readonly before: WireValue; readonly after: WireValue }> & { key?: string }
  >({ loading: false });
  const key = `${persistenceId ?? ''}@${String(seq)}`;

  useEffect(() => {
    if (path === undefined || persistenceId === undefined || seq === undefined) return;
    const history = historyOf(client, persistenceId);
    let cancelled = false;
    const at = async (n: number): Promise<WireValue> => {
      const cached = history.states.get(n);
      if (cached !== undefined) return cached;
      const res = await client.request({ type: 'stateAt', path, seq: n });
      if (!res.ok) throw new Error(errorText(res));
      if (res.type !== 'stateAt') throw new Error('unexpected answer');
      history.states.set(n, res.state);
      return res.state;
    };
    Promise.all([at(Math.max(0, seq - 1)), at(seq)]).then(
      ([before, after]) => {
        if (!cancelled) setAnswer({ value: { before, after }, loading: false, key });
      },
      (error: unknown) => {
        if (!cancelled) {
          setAnswer({
            error: error instanceof Error ? error.message : String(error),
            loading: false,
            key,
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, path, persistenceId, seq, key]);

  return answer.key === key ? answer : { loading: true };
}
