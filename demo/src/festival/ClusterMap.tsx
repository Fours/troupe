// The cluster map: a card per node with the shows it runs, built from every node's events, and the
// buttons that act on that node. Backstage shows one node from the inside; this shows them all.
import { colourOf } from '../../../backstage/src/ui/Cluster.tsx';
import type { NodeState } from './domain/festival-night.ts';
import type { StageNode, StageView } from './domain/stage.ts';

const STATE_WORDS: Readonly<Record<NodeState, string>> = {
  joining: 'joining',
  up: 'up',
  leaving: 'leaving',
  left: 'left',
  killed: 'killed',
};

/** What the map's buttons do. */
export interface NodeActions {
  readonly kill: (address: string) => void;
  readonly restart: (address: string) => void;
  readonly leave: (address: string) => void;
}

export interface ClusterMapProps {
  readonly stage: StageView;
  readonly actions: NodeActions;
  /** False while the night is starting. */
  readonly ready: boolean;
}

/** Every node that hosts shows, with its shows and its buttons. */
export function ClusterMap({ stage, actions, ready }: ClusterMapProps) {
  return (
    <ul className="cluster-map" aria-label="Nodes">
      {stage.nodes.map((node) => (
        <NodeCard key={node.address} node={node} actions={actions} ready={ready} />
      ))}
    </ul>
  );
}

function NodeCard({
  node,
  actions,
  ready,
}: {
  node: StageNode;
  actions: NodeActions;
  ready: boolean;
}) {
  const { address, state, incarnation, shows } = node;
  const colour = colourOf(address, []);
  const running = state === 'up' || state === 'joining';
  const gone = state === 'killed' || state === 'left';
  const live = shows.filter((s) => !s.stranded);
  const stranded = shows.filter((s) => s.stranded);
  const heading = `node-card-${address}`;
  return (
    <li
      className={`node-card node-${String(colour)} node-${state}`}
      aria-labelledby={heading}
      data-state={state}
    >
      <h3 id={heading}>
        <span className="swatch" aria-hidden="true" />
        {address}
      </h3>
      <p className="node-state">
        <span className={`state state-${state}`}>{STATE_WORDS[state]}</span>
        {incarnation > 1 && <span className="incarnation"> · start {incarnation}</span>}
      </p>
      <ul className="node-shows" aria-label={`Shows on ${address}`}>
        {live.map((s) => (
          <li key={s.id}>{s.id}</li>
        ))}
        {stranded.map((s) => (
          <li key={s.id} className="stranded" title="Waiting for its lease to run out">
            {s.id}
          </li>
        ))}
      </ul>
      {live.length === 0 && stranded.length === 0 && (
        <p className="node-empty">{gone ? 'No shows.' : 'No shows yet.'}</p>
      )}
      {stranded.length > 0 && (
        <p className="node-note">
          Stranded: no other node may run them until {address}'s leases run out.
        </p>
      )}
      <div className="node-buttons">
        {running && (
          <>
            <button
              type="button"
              disabled={!ready}
              onClick={() => {
                actions.kill(address);
              }}
            >
              Kill node
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!ready || state !== 'up'}
              onClick={() => {
                actions.leave(address);
              }}
            >
              Leave gracefully
            </button>
          </>
        )}
        {gone && (
          <button
            type="button"
            disabled={!ready}
            onClick={() => {
              actions.restart(address);
            }}
          >
            Restart node
          </button>
        )}
      </div>
    </li>
  );
}
