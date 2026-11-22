// Backstage: the tree, the selected actor's details and its timeline, side by side on a wide
// screen and one at a time, behind tabs, on a phone. Each panel says in a sentence what it
// shows, with the technical detail one click away.

import { useState, type ReactNode } from 'react';
import type { BackstageClient } from '../client.ts';
import { Details } from './Details.tsx';
import { useBackstage } from './hooks.ts';
import { Timeline } from './Timeline.tsx';
import { Tree } from './Tree.tsx';
import './backstage.css';

/** The panels, in the order the phone's tabs show them. */
export type Panel = 'tree' | 'details' | 'timeline';

const PANELS: readonly { readonly id: Panel; readonly label: string }[] = [
  { id: 'tree', label: 'Actors' },
  { id: 'details', label: 'Details' },
  { id: 'timeline', label: 'Timeline' },
];

export interface BackstageProps {
  readonly client: BackstageClient;
  /** The selected actor's path. */
  readonly selected: string | undefined;
  readonly onSelect: (path: string) => void;
  /** Extra words under each panel's heading, such as what the demo's actors are. */
  readonly explain?: Partial<Record<Panel, ReactNode>>;
}

/** The whole inspector, for one client. */
export function Backstage({ client, selected, onSelect, explain = {} }: BackstageProps) {
  const view = useBackstage(client);
  const [tab, setTab] = useState<Panel>('tree');
  const actor = view.actors.find((a) => a.path === selected);

  const panel = (
    id: Panel,
    title: string,
    words: ReactNode,
    detail: ReactNode,
    body: ReactNode,
  ) => (
    <section
      id={`bs-panel-${id}`}
      className={`bs-panel bs-panel-${id}${tab === id ? ' bs-active' : ''}`}
      aria-labelledby={`bs-heading-${id}`}
    >
      <h2 id={`bs-heading-${id}`}>{title}</h2>
      <p className="bs-explain">
        {words} {explain[id]}
      </p>
      <details className="bs-more">
        <summary>Technical detail</summary>
        {detail}
      </details>
      {body}
    </section>
  );

  return (
    <div className="backstage" data-connection={view.connection}>
      <div className="bs-grid">
        <div role="tablist" aria-label="Backstage panels" className="bs-tabs">
          {PANELS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`bs-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`bs-panel-${id}`}
              onClick={() => {
                setTab(id);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {panel(
          'tree',
          'Actors',
          'Every row is an actor: a small program with its own mailbox, handling one message at a time. The bar shows how many messages wait for it. A line flashes from sender to receiver as each message is sent.',
          <p>
            The tree under <code>/user</code>, live from the system's events. A row fades out when
            its actor stops. Message events carry the sender's path when it's known (decision 0020),
            which draws the links. Temporary <code>ask</code> refs aren't actors, so they aren't
            shown.
          </p>,
          view.connected ? (
            <Tree
              actors={view.actors}
              flows={view.flows}
              selected={selected}
              onSelect={(path, open) => {
                onSelect(path);
                if (open) setTab('details');
              }}
            />
          ) : (
            <p className="bs-empty">Connecting…</p>
          ),
        )}

        {panel(
          'details',
          actor === undefined ? 'Details' : `Details: ${actor.name}`,
          'What the picked actor remembers, how busy it has been, and every time it failed and was restarted.',
          <p>
            The state is read with a <code>state</code> request each time a message changes it.
            Waited is the time from going into the mailbox to being taken, and took is the handler's
            time, both in the system's own time. Backstage only watches: nothing here can change an
            actor (decision 0021).
          </p>,
          <Details client={client} actor={actor} now={view.now} />,
        )}

        {panel(
          'timeline',
          'Timeline',
          'A persistent actor writes down everything that happens to it as events. Go back to any event to see what it knew then.',
          <p>
            Events come from the journal with <code>timeline</code> requests, and each state from{' '}
            <code>stateAt</code>, which folds the journal's events up to that point as recovery
            does, without touching the live actor. History doesn't change, so both are cached.
          </p>,
          <Timeline key={actor?.persistenceId ?? 'none'} client={client} actor={actor} />,
        )}
      </div>
    </div>
  );
}
