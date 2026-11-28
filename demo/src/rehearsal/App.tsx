import { useEffect, useState } from 'react';
import type { FaultPlan, NetworkMode } from '@kylewillett/troupe/rehearsal';
import { SiteBar } from '../site/SiteBar.tsx';
import { RECORDS, recordUrl, type RecordId } from '../writeup/records.ts';
import type { FoundBug, RecordedRun, RehearsalData } from './data.ts';
import { faultText } from './domain/drawing.ts';
import { RunView } from './RunView.tsx';
import { useRehearsal, type Requested } from './useRehearsal.ts';

const thousands = (n: number): string => Math.round(n).toLocaleString('en-US');

/** A sentence's first letter in capitals. */
const sentence = (s: string): string => `${s.slice(0, 1).toUpperCase()}${s.slice(1)}`;

const isRecord = (id: string | undefined): id is RecordId => id !== undefined && id in RECORDS;

/** The worker's answer for one drawing: on its way, drawn, or failed. */
function Drawn({ requested, label }: { requested: Requested | undefined; label: string }) {
  if (requested === undefined) return null;
  if (requested.state === 'running') return <p className="pending">Running it…</p>;
  if (requested.state === 'failed') {
    return (
      <p role="alert" className="error">
        The run failed: {requested.message}
      </p>
    );
  }
  return <RunView drawing={requested.drawing} label={label} />;
}

/**
 * What the two network modes are, and why there are two (decision 0035). The page's other
 * mentions of a mode link here.
 */
function Modes() {
  return (
    <section className="modes-explained" aria-labelledby="modes">
      <h3 id="modes">Contract or chaos: how badly the network may behave</h3>
      <div className="mode-cards">
        <article aria-labelledby="mode-contract">
          <h4 id="mode-contract">Contract</h4>
          <p>
            The network fails only in the ways a real one does. Connections drop, messages slow
            down, and parts of the cluster lose touch with each other for a while. But a message
            that does arrive arrives once, and in the order it was sent on its connection. That’s
            the promise TCP keeps, and Troupe’s network layer is built on it: it’s the{' '}
            <em>contract</em>.
          </p>
          <p>
            <strong>Why:</strong> it tests the cluster against the network it will really get.
          </p>
          <p>
            <strong>Checked:</strong> no show ever runs twice at once, no sale a customer was told
            about is lost, nobody is shown older sales than someone before them, and the cluster
            settles once the faults heal. And, because the contract promises it, no message is
            handled twice and messages from one sender arrive in order.
          </p>
        </article>
        <article aria-labelledby="mode-chaos">
          <h4 id="mode-chaos">Chaos</h4>
          <p>
            Everything contract mode does, and the network breaks its promise too: single messages
            vanish, arrive twice, or overtake each other on the same connection. A healthy network
            never does this.
          </p>
          <p>
            <strong>Why:</strong> Troupe’s most important guarantees, one copy of a show at a time
            and no lost sales, shouldn’t depend on the network behaving at all. They rest on each
            show’s lease and its journal. Chaos mode proves they hold anyway.
          </p>
          <p>
            <strong>Checked:</strong> the same, except the two rules about duplicate and
            out-of-order messages, which chaos breaks on purpose.
          </p>
        </article>
      </div>
      <p className="mode-source">
        The design record behind the two modes: <a href={recordUrl('0035')}>0035</a>.
      </p>
    </section>
  );
}

function Seeds({ rehearsal }: { rehearsal: ReturnType<typeof useRehearsal> }) {
  const { progress, error, start, stop, request } = rehearsal;
  const [mode, setMode] = useState<NetworkMode>('contract');
  const running = progress?.running === true;
  const perSecond =
    progress === undefined || progress.ms === 0 ? 0 : (progress.runs * 1_000) / progress.ms;
  const from = progress !== undefined && progress.mode === mode ? progress.next : 1;

  return (
    <section aria-labelledby="seeds-h">
      <h2 id="seeds-h">Run seeds</h2>
      <p className="section-lede">
        Each run is a minute of festival night: three nodes running a dozen shows, a spare that may
        join, and the crowd’s node buying tickets, with faults drawn from its seed. Here they run in
        your browser, one after another, as fast as one core allows, and each is checked when it
        ends. Pick how badly the network between the nodes may behave: contract or chaos.
      </p>
      <Modes />
      <div className="controls">
        <fieldset className="modes" disabled={running}>
          <legend>Network</legend>
          {(['contract', 'chaos'] as const).map((m) => (
            <label key={m}>
              <input
                type="radio"
                name="mode"
                checked={mode === m}
                onChange={() => {
                  setMode(m);
                }}
              />
              {m === 'contract' ? 'Contract' : 'Chaos'}
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          onClick={() => {
            if (running) stop();
            else start(mode, from);
          }}
        >
          {running ? 'Stop' : from === 1 ? 'Run seeds' : 'Keep going'}
        </button>
        <dl className="counts">
          <div>
            <dt>Runs</dt>
            <dd>
              <output aria-label="Runs">{thousands(progress?.runs ?? 0)}</output>
            </dd>
          </div>
          <div>
            <dt>Runs a second</dt>
            <dd>
              <output aria-label="Runs a second">{perSecond.toFixed(1)}</output>
            </dd>
          </div>
          <div>
            <dt>Next seed</dt>
            <dd>
              <output aria-label="Next seed">{thousands(from)}</output>
            </dd>
          </div>
          <div>
            <dt>Problems found</dt>
            <dd>
              <output aria-label="Problems found">{thousands(progress?.failing ?? 0)}</output>
            </dd>
          </div>
        </dl>
      </div>
      {error !== undefined && (
        <p role="alert" className="error">
          The runs stopped: {error}
        </p>
      )}
      {progress !== undefined && progress.problems.length > 0 && (
        <ul className="problems" aria-label="Seeds that broke something">
          {progress.problems.map((p) => (
            <li key={`${p.mode} ${String(p.seed)}`}>
              Seed {p.seed}, {p.mode}: {p.invariant}: {p.message}{' '}
              <button
                type="button"
                onClick={() => {
                  request('one', p.mode, p.seed);
                }}
              >
                Draw it
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OneRun({ rehearsal }: { rehearsal: ReturnType<typeof useRehearsal> }) {
  const { requested, request } = rehearsal;
  const [seed, setSeed] = useState(1);
  const [mode, setMode] = useState<NetworkMode>('contract');
  const one = requested.one;

  return (
    <section aria-labelledby="one-h">
      <h2 id="one-h">One run, drawn</h2>
      <p className="section-lede">
        Time runs across. Each node has a lane: pale while it’s up, striped while it’s down, amber
        while it’s frozen, violet while it’s cut off from some of the others. The thin bars are the
        shows, a row each, on the node that ran them, so a show that moved shows up on another lane.
        The ticks at the top of a lane are the network misbehaving, and the database’s lane has its
        own faults. The last 20 seconds have no faults at all, to see that everything heals. Drag
        the slider to step through it.
      </p>
      <form
        className="controls"
        onSubmit={(e) => {
          e.preventDefault();
          request('one', mode, seed);
        }}
      >
        <label>
          Seed{' '}
          <input
            type="number"
            min={1}
            step={1}
            value={seed}
            onChange={(e) => {
              setSeed(Math.max(1, Math.floor(Number(e.target.value) || 1)));
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={mode === 'chaos'}
            onChange={(e) => {
              setMode(e.target.checked ? 'chaos' : 'contract');
            }}
          />{' '}
          Chaos mode
        </label>
        <a href="#modes" className="hint">
          Contract or chaos?
        </a>
        <button type="submit">Draw it</button>
      </form>
      <Drawn requested={one} label={`One run: seed ${String(seed)}`} />
    </section>
  );
}

function PlantedRun({
  run,
  row,
}: {
  run: RecordedRun;
  row: RehearsalData['planted'][number] | undefined;
}) {
  return (
    <article className="bug" aria-labelledby={`bug-${run.plant}`}>
      <h4 id={`bug-${run.plant}`}>{sentence(run.bug)}</h4>
      {row?.foundAtSeed !== undefined && (
        <p className="found-how">
          Found on seed {thousands(row.foundAtSeed)}, whose plan had {row.faults ?? '?'} faults, and
          shrunk to {row.shrunkTo === 0 ? 'no faults at all' : String(row.shrunkTo)} in{' '}
          {row.shrinkRuns ?? '?'} more runs.
        </p>
      )}
      <RunView drawing={run.drawing} label={`Planted: ${run.plant}`} />
      <details>
        <summary>Replay it</summary>
        <pre>
          <code>npm run rehearse -- --replay &apos;{run.replay}&apos;</code>
        </pre>
      </details>
    </article>
  );
}

function planWords(plan: FaultPlan): string {
  return plan.map((f) => faultText(f)).join('; then ');
}

function FoundRow({
  bug,
  index,
  rehearsal,
}: {
  bug: FoundBug;
  index: number;
  rehearsal: ReturnType<typeof useRehearsal>;
}) {
  const id = `found-${String(index)}`;
  const requested = rehearsal.requested[id];
  return (
    <li className="found" aria-labelledby={`${id}-h`}>
      <h4 id={`${id}-h`}>{bug.name}</h4>
      <p>{bug.what}.</p>
      <p>
        <strong>The fix:</strong> {bug.fix}.
        {isRecord(bug.record) && (
          <>
            {' '}
            See <a href={recordUrl(bug.record)}>{bug.record}</a>.
          </>
        )}
      </p>
      <p className="plan">
        Seed {thousands(bug.seed)}, {bug.mode} mode, broke {bug.invariant} when{' '}
        {planWords(bug.plan)}.
      </p>
      {requested === undefined ? (
        <button
          type="button"
          onClick={() => {
            rehearsal.request(id, bug.mode, bug.seed, bug.plan);
          }}
        >
          Run it on today’s code
        </button>
      ) : (
        <Drawn requested={requested} label={`Found: ${bug.name}, on today’s code`} />
      )}
    </li>
  );
}

/**
 * Rehearsal: festival night rehearsed seed after seed in a worker, one run drawn in detail, and
 * the bugs it found, planted and real.
 */
export function App({ data }: { data: RehearsalData }) {
  const rehearsal = useRehearsal();
  const { request } = rehearsal;
  useEffect(() => {
    request('one', 'contract', 1);
  }, [request]);
  const tolerated = data.planted.filter((p) => p.tolerated !== undefined);

  return (
    <>
      <SiteBar page="rehearsal" />
      <main>
        <header>
          <h1>Rehearsal</h1>
          <p className="lede">
            Festival night again, but rehearsed. The whole cluster runs inside one simulation: the
            nodes, the network between them, the database behind them and every clock. Each run
            lasts a minute of pretend time, with things going wrong on purpose: crashes, freezes,
            cut cables, slow disks, clocks that drift. When a run ends, it’s checked for the things
            that must never happen, such as two copies of one show selling the same seats, or a sale
            the customer was told about going missing. One number, the run’s seed, decides
            everything that happens in it, so a run that goes wrong can be replayed exactly, as
            often as it takes to understand it.
          </p>
          <p className="lede">
            Troupe has been rehearsed this way {thousands(data.hunt.seeds)} times. That found{' '}
            {data.found.length} bugs in the real code, each now fixed. And to prove the checks work,
            old bugs were put back on purpose, one at a time, and Rehearsal found them.
          </p>
        </header>

        <Seeds rehearsal={rehearsal} />
        <OneRun rehearsal={rehearsal} />

        <section aria-labelledby="bugs-h">
          <h2 id="bugs-h">The bugs it found</h2>
          <h3>Bugs put back on purpose</h3>
          <p className="section-lede">
            A check that never fails proves nothing. So each of these bugs was put back into Troupe,
            one at a time, and Rehearsal had to find it from random seeds without being told where
            to look, then shrink the run to the fewest faults that still show it. Each run is drawn
            as it was recorded, with the moment it broke in red, and the show it broke in red too.
          </p>
          {data.runs.map((run) => (
            <PlantedRun
              key={run.plant}
              run={run}
              row={data.planted.find((p) => p.plant === run.plant)}
            />
          ))}
          {tolerated.map((row) => (
            <article className="bug" key={row.plant} aria-labelledby={`bug-${row.plant}`}>
              <h4 id={`bug-${row.plant}`}>{row.bug}</h4>
              <p>
                Not found, and that’s now expected: {row.tolerated}. Its hunt ran 10,000 seeds with
                the bug in place, and every one passed.
              </p>
            </article>
          ))}

          <h3>Bugs it found in the real code</h3>
          <p className="section-lede">
            Then Rehearsal ran against Troupe as it was, {thousands(data.hunt.seeds)} seeds of it,
            and found these, in this order. Each was fixed, and the run that showed it is now a test
            that must pass. The fixes landed together, so these runs can’t be drawn failing any
            more: run one, and you’ll see the same faults healed by today’s code.
          </p>
          <ol className="found-list">
            {data.found.map((bug, i) => (
              <FoundRow key={bug.name} bug={bug} index={i} rehearsal={rehearsal} />
            ))}
          </ol>
          <p>
            The hunt also found {data.hunt.checkBugs} bugs in Rehearsal’s own checks. The numbers,
            and how each fix was decided, are in <a href={recordUrl('0043')}>0043</a> and{' '}
            <a href="../how-it-works/#rehearsal">How it works</a>.
          </p>
        </section>
      </main>
    </>
  );
}
