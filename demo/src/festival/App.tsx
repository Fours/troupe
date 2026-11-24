import { useState } from 'react';
import { Backstage } from '../../../backstage/src/index.ts';
import { SPEEDS, type Speed } from '../domain/clock.ts';
import { RUSH_SIZE } from '../domain/crowd.ts';
import { SiteBar } from '../site/SiteBar.tsx';
import { ClusterMap } from './ClusterMap.tsx';
import { CROWD, HOSTS } from './domain/festival-night.ts';
import { LINEUP } from './domain/lineup.ts';
import { FIRST_PICK, useFestivalNight } from './useFestivalNight.ts';

const SPEED_LABELS: Record<Speed, string> = { 0: 'Paused', 0.25: '¼×', 1: '1×', 4: '4×' };

/** Virtual ms as m:ss.t */
function showtime(ms: number): string {
  const tenths = Math.floor(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${String(minutes)}:${seconds.toFixed(1).padStart(4, '0')}`;
}

/**
 * Festival night: opening night's box office spread over a cluster of nodes in the page, the
 * buttons that kill, restart, add and retire them, and Backstage on whichever node you pick.
 */
export function App() {
  const [speed, setSpeed] = useState<Speed>(1);
  const { night, client, view } = useFestivalNight(1, speed);
  const [picked, setPicked] = useState(FIRST_PICK);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const ready = night !== undefined;
  const nodes = view.stage.nodes;
  const canAdd = ready && nodes.length < HOSTS.length;
  const pickable = [CROWD, ...nodes.map((n) => n.address)];
  const stateOf = (address: string) => nodes.find((n) => n.address === address)?.state;
  const pickedState = picked === CROWD ? 'up' : stateOf(picked);

  const pick = (address: string) => {
    setPicked(address);
    setSelected(undefined);
    client?.pick(address);
  };

  return (
    <>
      <SiteBar page="cluster" />
      <main>
        <header>
          <h1>Festival night</h1>
          <p className="lede">
            The box office from opening night, now spread over a cluster: several copies of the
            system, called nodes, running side by side in this page as they would on separate
            machines. {Object.keys(LINEUP).length} shows are shared out among the nodes, and a
            fourth node, the crowd's, sends customers to whichever node runs their show. Pull the
            plug on a node and watch its shows come back on the others, with every ticket they sold.
          </p>
        </header>

        <section aria-label="Controls" className="controls">
          <fieldset className="speed">
            <legend>Speed</legend>
            {SPEEDS.map((s) => (
              <label key={s}>
                <input
                  type="radio"
                  name="speed"
                  checked={speed === s}
                  onChange={() => {
                    setSpeed(s);
                  }}
                />
                {SPEED_LABELS[s]}
              </label>
            ))}
          </fieldset>
          <p className="clock">
            Showtime <output aria-label="Showtime">{showtime(view.now)}</output>
          </p>
          <div className="buttons">
            <button type="button" disabled={!ready} onClick={() => void night?.rush()}>
              Rush
            </button>
            <button type="button" disabled={!canAdd} onClick={() => void night?.add()}>
              Add a node
            </button>
          </div>
          <p className="hint">
            <strong>Kill node</strong> pulls the plug: the node vanishes without a word, and the
            others take a few seconds to be sure it's gone before they run its shows.{' '}
            <strong>Restart node</strong> starts it again, and <strong>Add a node</strong> starts a
            new one, up to {HOSTS.length}: some shows move to it, one or two at a time.{' '}
            <strong>Leave gracefully</strong> hands a node's shows to the others before it stops, so
            no customer waits. <strong>Rush</strong> sends {RUSH_SIZE} customers at once.
          </p>
        </section>

        {view.error !== undefined && (
          <p role="alert" className="error">
            The demo stopped: {view.error}
          </p>
        )}

        <section className="map" aria-labelledby="map-heading">
          <h2 id="map-heading">The cluster</h2>
          <p className="section-lede">
            Which node runs each show, as all the nodes tell it. A striped show is stranded on a
            killed node, waiting for its lease to run out.
          </p>
          <ClusterMap
            stage={view.stage}
            ready={ready}
            actions={{
              kill: (a) => void night?.kill(a),
              restart: (a) => void night?.restart(a),
              leave: (a) => void night?.leave(a),
            }}
          />
        </section>

        <div className="stage">
          <section className="log" aria-labelledby="log-heading">
            <h2 id="log-heading">What's happening</h2>
            <ol aria-labelledby="log-heading">
              {view.lines.map((line) => (
                <li key={line.id}>
                  <time>{showtime(line.at)}</time> {line.text}
                </li>
              ))}
            </ol>
          </section>

          <section className="inspector" aria-labelledby="backstage-heading">
            <h2 id="backstage-heading">Backstage</h2>
            <fieldset className="picker">
              <legend>Look inside</legend>
              {pickable.map((address) => {
                const state = address === CROWD ? 'up' : stateOf(address);
                return (
                  <label key={address}>
                    <input
                      type="radio"
                      name="node"
                      checked={picked === address}
                      disabled={state === 'killed' || state === 'left'}
                      onChange={() => {
                        pick(address);
                      }}
                    />
                    {address === CROWD ? "the crowd's node" : address}
                  </label>
                );
              })}
            </fieldset>
            {(pickedState === 'killed' || pickedState === 'left') && (
              <p className="frozen" role="status">
                {picked} {pickedState === 'killed' ? 'was killed' : 'has left'}. Backstage shows it
                as it last was.
              </p>
            )}
            {client === undefined ? (
              <p>Opening the doors…</p>
            ) : (
              <Backstage
                client={client}
                selected={selected}
                onSelect={setSelected}
                explain={{
                  cluster:
                    'The colours match the cards above. A node only learns who owns a shard as it sends a customer there, so the crowd’s node knows the most.',
                  tree: 'On a node that runs shows: its region, which routes messages for shows, its shards, and in each shard its shows. On the crowd’s node: the box office, the crowd and its customers, and the sales board.',
                  timeline:
                    "A show's journal holds every hold, sale, release and return, wherever the show ran.",
                }}
              />
            )}
          </section>
        </div>
      </main>
    </>
  );
}
