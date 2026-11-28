// A persistent actor's journal, as a timeline to scrub. Picking an event shows the actor's state
// after it, read from the journal with `stateAt` rather than from the live actor, with what that
// event changed highlighted. "Live" goes back to the actor's state now.

import type { BackstageClient, TimelineEvent } from '@kylewillett/troupe/backstage';
import { useMemo, useState } from 'react';
import { diff } from '../store/diff.ts';
import type { ActorView } from '../store/store.ts';
import { formatTime, summarize } from './format.ts';
import { useActorState, useStateAt, useTimeline } from './hooks.ts';
import { Value } from './Value.tsx';

/** How many events the list shows around the one picked. */
const WINDOW = 40;

export interface TimelineProps {
  readonly client: BackstageClient;
  readonly actor: ActorView | undefined;
}

/** The timeline panel. Give it a `key` per actor, so a new actor starts at Live. */
export function Timeline({ client, actor }: TimelineProps) {
  const persistenceId = actor?.persistenceId;
  const path = actor?.phase === 'stopped' ? undefined : actor?.path;
  const timeline = useTimeline(client, path, persistenceId, actor?.lastSeq ?? 0);
  const [picked, setPicked] = useState<number>();
  const events = timeline.value ?? [];
  const last = events.length;
  const seq = picked === undefined ? undefined : Math.min(picked, last);
  const at = useStateAt(client, path, persistenceId, seq === 0 ? undefined : seq);
  const live = useActorState(
    client,
    seq === undefined ? path : undefined,
    actor?.stateVersion ?? 0,
  );
  const changes = useMemo(
    () => (at.value === undefined ? undefined : diff(at.value.before, at.value.after)),
    [at.value],
  );

  if (actor === undefined || persistenceId === undefined) {
    return (
      <p className="bs-empty">
        Pick a persistent actor, such as a show, to see the events in its journal.
      </p>
    );
  }

  const current = seq === undefined ? undefined : events[seq - 1];
  const from = Math.max(0, Math.min((seq ?? last) - WINDOW / 2, last - WINDOW));
  const shown = events.slice(from, from + WINDOW);

  return (
    <div className="bs-timeline">
      <h3 className="bs-title">
        {actor.name}'s journal <span className="bs-path">{persistenceId}</span>
      </h3>
      <p className="bs-summary">
        {last === 0
          ? 'Nothing written yet.'
          : `${String(last)} ${last === 1 ? 'event' : 'events'}. Drag the slider, or use the arrow keys, to see the state after any one of them.`}
      </p>
      {timeline.error !== undefined && (
        <p className="bs-error">Couldn't read more of the journal: {timeline.error}</p>
      )}

      <div className="bs-scrubber">
        <input
          type="range"
          min={1}
          max={Math.max(1, last)}
          step={1}
          value={seq ?? Math.max(1, last)}
          disabled={last === 0}
          aria-label="Event"
          aria-valuetext={
            current === undefined
              ? 'Live'
              : `Event ${String(current.seq)} of ${String(last)}: ${eventType(current)}`
          }
          onChange={(e) => {
            setPicked(Number(e.currentTarget.value));
          }}
        />
        <button
          type="button"
          aria-pressed={seq === undefined}
          onClick={() => {
            setPicked(undefined);
          }}
        >
          Live
        </button>
      </div>

      <section aria-labelledby="bs-at-heading">
        <h4 id="bs-at-heading">
          {current === undefined
            ? 'State now'
            : `State after event ${String(current.seq)}, at ${formatTime(current.timestamp)}`}
        </h4>
        {seq === undefined ? (
          live.value === undefined ? (
            <p className={live.error === undefined ? 'bs-empty' : 'bs-error'}>
              {live.error ?? 'Reading…'}
            </p>
          ) : (
            <Value value={live.value} />
          )
        ) : at.error !== undefined ? (
          <p className="bs-error">Couldn't read it from the journal: {at.error}</p>
        ) : at.value === undefined ? (
          <p className="bs-empty">Reading the journal…</p>
        ) : (
          <>
            <Value value={at.value.after} {...(changes === undefined ? {} : { diff: changes })} />
            <p className="bs-note">
              <mark className="bs-changed">Highlighted</mark> is what this event changed, and{' '}
              <del className="bs-removed">struck through</del> what it removed.
            </p>
          </>
        )}
      </section>

      <section aria-labelledby="bs-events-heading">
        <h4 id="bs-events-heading">Events</h4>
        <ol className="bs-events" start={from + 1}>
          {shown.map((event) => (
            <li key={event.seq}>
              <button
                type="button"
                className="bs-event"
                aria-current={event.seq === seq ? 'true' : undefined}
                onClick={() => {
                  setPicked(event.seq);
                }}
              >
                <span className="bs-seq">{event.seq}</span>
                <code>{summarize(event.event, 70)}</code>
                {event.tags.map((tag) => (
                  <span key={tag} className="bs-tag">
                    {tag}
                  </span>
                ))}
                <time>{formatTime(event.timestamp)}</time>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function eventType(event: TimelineEvent): string {
  const { event: value } = event;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const type = (value as { type?: unknown }).type;
    if (typeof type === 'string') return type;
  }
  return summarize(value, 30);
}
