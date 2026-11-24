// The cluster panel: the members as the attached node sees them, and a grid of each entity type's
// shards, coloured by the node that owns each one. A shard that changes owner flashes, so a
// failover or a handoff is something you watch happen.

import { memo } from 'react';
import type { ClusterView, EntityTypeView, MemberView, ShardView } from '../store/store.ts';

/** How many node colours the CSS defines. Nodes past that share them. */
const COLOURS = 6;

/**
 * A colour per address, by its number if it ends in one (node-2 is colour 1), else by its place
 * among the members. By address, not by uid, so a restarted node keeps its colour.
 */
export function colourOf(address: string, members: readonly MemberView[]): number {
  const digits = /(\d+)$/.exec(address)?.[1];
  if (digits !== undefined) return (Number(digits) + COLOURS - 1) % COLOURS;
  const index = members.findIndex((m) => m.address === address);
  return (index < 0 ? 0 : index) % COLOURS;
}

/** A holder name, `<address>#<uid>`, split. */
function holderParts(owner: string): { address: string; uid: string } {
  const cut = owner.lastIndexOf('#');
  return { address: owner.slice(0, cut), uid: owner.slice(cut + 1) };
}

const STATUS_WORDS: Readonly<Record<MemberView['status'], string>> = {
  up: 'up',
  leaving: 'leaving',
  down: 'down',
};

export interface ClusterProps {
  readonly cluster: ClusterView;
}

/** The members and the shard grids. */
export function Cluster({ cluster }: ClusterProps) {
  const { members, types } = cluster;
  return (
    <div className="bs-cluster">
      <table className="bs-members" aria-label="Members">
        <thead>
          <tr>
            <th scope="col">Node</th>
            <th scope="col">Status</th>
            <th scope="col">Heard</th>
            <th scope="col">Shards</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const owned = types.reduce(
              (sum, t) => sum + t.shards.filter((s) => s.owner === m.key).length,
              0,
            );
            return (
              <tr key={m.key} data-status={m.status} data-reachable={m.reachable}>
                <th scope="row">
                  <span
                    className={`bs-swatch bs-node-${String(colourOf(m.address, members))}`}
                    aria-hidden="true"
                  />
                  {m.address}
                  {m.self && <span className="bs-tag">this node</span>}
                  <span className="bs-uid" title="Its uid, new every time it starts">
                    #{m.uid}
                  </span>
                </th>
                <td className={`bs-status-${m.status}`}>{STATUS_WORDS[m.status]}</td>
                <td className={m.reachable ? '' : 'bs-unreachable'}>
                  {m.self ? '—' : m.reachable ? 'yes' : 'no'}
                </td>
                <td>{owned}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="bs-shard-types">
        {types.length === 0 ? (
          <p className="bs-empty">No entity types on this node yet.</p>
        ) : (
          types.map((t) => <ShardGrid key={t.type} type={t} cluster={cluster} />)
        )}
      </div>
    </div>
  );
}

interface ShardGridProps {
  readonly type: EntityTypeView;
  readonly cluster: ClusterView;
}

/** One type's shards, in order, each coloured by its owner. */
export const ShardGrid = memo(function ShardGrid({ type, cluster }: ShardGridProps) {
  const known = type.shards.filter((s) => s.owner !== undefined).length;
  return (
    <section className="bs-shard-type" aria-label={`${type.type} shards`}>
      <h3>
        {type.type}{' '}
        <span className="bs-note">
          {known} of {type.shardCount} shards with a known owner
          {type.host ? '' : ' · this node only routes'}
        </span>
      </h3>
      <ol className="bs-shards" aria-label={`${type.type} shards`}>
        {type.shards.map((s) => (
          <Shard key={s.shard} shard={s} cluster={cluster} />
        ))}
      </ol>
    </section>
  );
});

function Shard({ shard, cluster }: { shard: ShardView; cluster: ClusterView }) {
  const { owner, movedAt, movedFrom } = shard;
  if (owner === undefined) {
    return (
      <li
        className="bs-shard bs-unowned"
        aria-label={`Shard ${String(shard.shard)}: no owner known`}
      >
        {shard.shard}
      </li>
    );
  }
  const { address, uid } = holderParts(owner);
  const member = cluster.members.find((m) => m.key === owner);
  // An owner that isn't a member now: an old incarnation, or a node that has gone.
  const gone = member === undefined || member.status === 'down';
  const from = movedFrom === undefined ? undefined : holderParts(movedFrom).address;
  const words = `Shard ${String(shard.shard)}: ${address}${gone ? ', gone' : ''}${
    movedAt === undefined ? '' : from === undefined ? ', just started' : `, moved from ${from}`
  }`;
  return (
    <li
      className={`bs-shard bs-node-${String(colourOf(address, cluster.members))}${
        gone ? ' bs-gone' : ''
      }${movedAt === undefined ? '' : ' bs-moved'}`}
      aria-label={words}
      title={`${words} (uid ${uid})`}
      data-owner={address}
    >
      {shard.shard}
    </li>
  );
}
