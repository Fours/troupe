// The selected actor: its state as it changes, its mailbox over the last 30 s, its recent
// messages, and its failures with the restart and backoff that followed each.

import type { BackstageClient } from '@kylewillett/troupe/backstage';
import type { ActorView, DepthSample, FailureView, MessageView } from '../store/store.ts';
import { describeMarker, formatDuration, formatTime, nameOf, summarize } from './format.ts';
import { useActorState } from './hooks.ts';
import { Value } from './Value.tsx';

/** How much mailbox history the chart shows, in ms. */
const CHART_MS = 30_000;

/** How many of the actor's recent messages the list shows. */
const SHOWN_MESSAGES = 25;

const OUTCOME_WORDS: Readonly<Record<MessageView['outcome'], string>> = {
  waiting: 'waiting',
  processed: 'handled',
  failed: 'threw',
  skipped: 'skipped',
  dropped: 'dropped',
};

export interface DetailsProps {
  readonly client: BackstageClient;
  readonly actor: ActorView | undefined;
  readonly now: number;
}

/** The details panel for one actor. */
export function Details({ client, actor, now }: DetailsProps) {
  const state = useActorState(
    client,
    actor?.phase === 'stopped' ? undefined : actor?.path,
    actor?.stateVersion ?? 0,
  );
  if (actor === undefined) {
    return <p className="bs-empty">Pick an actor in the tree to see inside it.</p>;
  }
  return (
    <div className="bs-details">
      <p className="bs-path">{actor.path}</p>
      <p className="bs-summary">
        {phaseSentence(actor)}{' '}
        {actor.depth === 0
          ? 'Its mailbox is empty.'
          : `${String(actor.depth)} messages wait in its mailbox.`}
      </p>

      <section aria-labelledby="bs-state-heading">
        <h4 id="bs-state-heading">State</h4>
        {actor.phase === 'stopped' ? (
          <p className="bs-empty">It has stopped, so it has no state.</p>
        ) : state.error !== undefined ? (
          <p className="bs-error">Couldn't read it: {state.error}</p>
        ) : state.value === undefined ? (
          <p className="bs-empty">Reading…</p>
        ) : (
          <Value value={state.value} />
        )}
      </section>

      <section aria-labelledby="bs-mailbox-heading">
        <h4 id="bs-mailbox-heading">Mailbox, last 30 s</h4>
        <DepthChart samples={actor.depths} now={now} />
      </section>

      <section aria-labelledby="bs-messages-heading">
        <h4 id="bs-messages-heading">Recent messages</h4>
        <Messages messages={actor.messages} />
      </section>

      <section aria-labelledby="bs-failures-heading">
        <h4 id="bs-failures-heading">Failures and restarts</h4>
        <Failures failures={actor.failures} />
      </section>
    </div>
  );
}

function phaseSentence(actor: ActorView): string {
  switch (actor.phase) {
    case 'starting':
      return actor.persistenceId === undefined
        ? 'It is starting.'
        : 'It is reading its journal to recover.';
    case 'running':
      return 'It is running.';
    case 'restarting':
      return 'It failed, and its supervisor will restart it after a pause.';
    case 'stopping':
      return 'It is stopping.';
    case 'stopped':
      return 'It has stopped.';
  }
}

function DepthChart({ samples, now }: { samples: readonly DepthSample[]; now: number }) {
  const width = 300;
  const height = 56;
  const start = now - CHART_MS;
  const shown = samples.filter((s, i) => s.at >= start || (samples[i + 1]?.at ?? now) > start);
  const most = shown.reduce((m, s) => Math.max(m, s.peak), 0);
  const peak = Math.max(1, most);
  const x = (at: number) => ((Math.max(at, start) - start) / CHART_MS) * width;
  const y = (depth: number) => height - 2 - (depth / peak) * (height - 4);
  let d = '';
  let last: DepthSample | undefined;
  for (const s of shown) {
    d +=
      last === undefined
        ? `M ${x(s.at).toFixed(1)} ${y(s.depth).toFixed(1)}`
        : ` H ${x(s.at).toFixed(1)} V ${y(s.peak).toFixed(1)} V ${y(s.depth).toFixed(1)}`;
    last = s;
  }
  if (last !== undefined) d += ` H ${String(width)}`;
  return (
    <figure className="bs-chart">
      <svg
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Mailbox depth: at most ${String(most)} in the last 30 seconds`}
      >
        <line x1="0" x2={width} y1={height - 2} y2={height - 2} className="bs-axis" />
        {d !== '' && <path d={d} className="bs-line" vectorEffect="non-scaling-stroke" />}
      </svg>
      <figcaption>At most {most} waiting. 30 s ago on the left, now on the right.</figcaption>
    </figure>
  );
}

function Messages({ messages }: { messages: readonly MessageView[] }) {
  if (messages.length === 0) return <p className="bs-empty">No messages yet.</p>;
  const recent = messages.slice(-SHOWN_MESSAGES).reverse();
  return (
    <div className="bs-scroll">
      <table className="bs-messages">
        <thead>
          <tr>
            <th scope="col">Message</th>
            <th scope="col">From</th>
            <th scope="col" title="Time in the mailbox">
              Waited
            </th>
            <th scope="col" title="Time in the handler">
              Took
            </th>
            <th scope="col">Then</th>
          </tr>
        </thead>
        <tbody>
          {recent.map((m) => (
            <tr key={m.id} className={`bs-outcome-${m.outcome}`}>
              <td className="bs-message">
                <code title={summarize(m.message, 400)}>{summarize(m.message, 60)}</code>
              </td>
              <td>{m.from === undefined ? '—' : nameOf(m.from)}</td>
              <td>{m.waitedMs === undefined ? '…' : formatDuration(m.waitedMs)}</td>
              <td>{m.handledMs === undefined ? '…' : formatDuration(m.handledMs)}</td>
              <td>
                {m.reason === undefined
                  ? OUTCOME_WORDS[m.outcome]
                  : `${OUTCOME_WORDS[m.outcome]} (${m.reason})`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {messages.length > SHOWN_MESSAGES && (
        <p className="bs-note">
          The last {SHOWN_MESSAGES} of {messages.length} kept.
        </p>
      )}
    </div>
  );
}

function Failures({ failures }: { failures: readonly FailureView[] }) {
  if (failures.length === 0) return <p className="bs-empty">None. It hasn't failed.</p>;
  return (
    <ol className="bs-failure-list" reversed>
      {[...failures].reverse().map((f, i) => (
        <li key={`${String(f.at)}:${String(failures.length - i)}`}>
          <time>{formatTime(f.at)}</time>{' '}
          <span className="bs-chip bs-chip-error">
            {describeMarker(f.error) ?? summarize(f.error)}
          </span>{' '}
          {f.directive === 'restart'
            ? f.restart === undefined
              ? 'Waiting to restart.'
              : `Restarted after ${formatDuration(f.restart.delayMs)} (attempt ${String(f.restart.attempt)}).`
            : f.directive === 'resume'
              ? 'Carried on with its state.'
              : 'Stopped.'}
        </li>
      ))}
    </ol>
  );
}
