import { Fragment, useEffect, useRef, useState } from 'react';
import {
  stateAt,
  type Drawing,
  type FaultBand,
  type Lane,
  type LaneState,
} from './domain/drawing.ts';

/** Simulation ms as m:ss.t */
export function clock(ms: number): string {
  const tenths = Math.floor(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${String(minutes)}:${seconds.toFixed(1).padStart(4, '0')}`;
}

/** Where the axis gets a tick: a step that gives at most seven, from a second up. */
export function ticks(endMs: number): number[] {
  const step = [1_000, 2_000, 5_000, 10_000, 20_000].find((s) => endMs / s <= 7) ?? 30_000;
  const out: number[] = [];
  for (let t = 0; t <= endMs; t += step) out.push(t);
  return out;
}

const STATE_WORDS: Record<LaneState, string> = {
  up: 'up',
  down: 'down',
  paused: 'frozen',
  partitioned: 'cut off',
};

// Faults the lane's own colour already shows: the node down, frozen or cut off.
const LANE_STATES = new Set(['kill', 'pause', 'leave', 'join', 'partition']);

const W = 1_000;
const STRIP = 6;
const ROW = 4;

function NodeLane({
  lane,
  drawing,
  x,
  row,
}: {
  lane: Lane;
  drawing: Drawing;
  x: (t: number) => number;
  row: number;
}) {
  const hosts = lane.role !== 'client';
  const height = STRIP + (hosts ? Math.max(drawing.shows.length, 1) * ROW + 2 : 10);
  const network = drawing.faults.filter(
    (f) => f.place === 'nodes' && !LANE_STATES.has(f.kind) && f.nodes.includes(lane.node),
  );
  const bars = drawing.bars.filter((b) => b.node === lane.node);
  return (
    <svg
      className="lane-plot"
      viewBox={`0 0 ${String(W)} ${String(height)}`}
      preserveAspectRatio="none"
      style={{ height: `${String(height)}px`, gridRow: row }}
      aria-hidden="true"
    >
      {lane.spans.map((s) => (
        <rect
          key={s.from}
          className={`span span-${s.state}`}
          x={x(s.from)}
          width={Math.max(x(s.to) - x(s.from), 0)}
          y={0}
          height={height}
        />
      ))}
      {network.map((f) => (
        <rect
          key={f.index}
          className={`fault fault-${f.kind}`}
          x={x(f.from)}
          width={Math.max(x(f.to) - x(f.from), 2)}
          y={0}
          height={STRIP - 1}
        />
      ))}
      {bars.map((b) => (
        <rect
          key={`${b.show} ${String(b.inc)} ${String(b.from)}`}
          className={b.marked ? 'bar bar-marked' : 'bar'}
          x={x(b.from)}
          width={Math.max(x(b.to) - x(b.from), 1)}
          y={STRIP + 1 + drawing.shows.indexOf(b.show) * ROW}
          height={ROW - 1}
        />
      ))}
    </svg>
  );
}

function DatabaseLane({
  faults,
  x,
  row,
}: {
  faults: readonly FaultBand[];
  x: (t: number) => number;
  row: number;
}) {
  const height = 18;
  return (
    <svg
      className="lane-plot"
      viewBox={`0 0 ${String(W)} ${String(height)}`}
      preserveAspectRatio="none"
      style={{ height: `${String(height)}px`, gridRow: row }}
      aria-hidden="true"
    >
      <rect className="span span-up" x={0} width={W} y={0} height={height} />
      {faults.map((f) => (
        <rect
          key={f.index}
          className={`fault fault-${f.kind}`}
          x={x(f.from)}
          width={Math.max(x(f.to) - x(f.from), 2)}
          y={2}
          height={height - 4}
        />
      ))}
    </svg>
  );
}

/**
 * One rehearsed run, drawn: simulation time across, a lane per node with its shows' instances as
 * bars, the database's lane, the faults in words, a scrubber, and the log up to the scrubber.
 */
export function RunView({ drawing, label }: { drawing: Drawing; label: string }) {
  const { mark, endMs } = drawing;
  const [time, setTime] = useState(mark?.time ?? endMs);
  const x = (t: number) => (Math.min(Math.max(t, 0), endMs) / Math.max(endMs, 1)) * W;
  const pct = (t: number) => `${String((x(t) / W) * 100)}%`;
  const database = drawing.faults.filter((f) => f.place === 'database');
  const seen = drawing.log.filter((l) => l.time <= time);
  const hosts = drawing.lanes.filter(
    (l) => l.role !== 'spare' || l.spans.some((s) => s.state !== 'down'),
  );
  const now = hosts
    .map(
      (l) =>
        `${l.role === 'client' ? 'the crowd’s node' : l.node} ${STATE_WORDS[stateAt(l, time)]}`,
    )
    .join(', ');
  // The log follows the scrubber, so its newest line stays in view.
  const logRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const list = logRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [seen.length]);

  return (
    <figure className="run" aria-label={label}>
      <div className="run-chart">
        <div className="axis" aria-hidden="true">
          {ticks(endMs).map((t) => (
            <span key={t} style={{ left: pct(t) }}>
              {String(t / 1_000)} s
            </span>
          ))}
          {mark !== undefined && (
            <b
              className={mark.time > endMs * 0.9 ? 'axis-mark at-end' : 'axis-mark'}
              style={{ left: pct(mark.time) }}
            >
              ✗ broke
            </b>
          )}
        </div>
        {hosts.map((l, i) => (
          <Fragment key={l.node}>
            <div
              className={`lane-label lane-${l.role}`}
              style={{ gridRow: i + 2 }}
              aria-hidden="true"
            >
              {l.node}
            </div>
            <NodeLane lane={l} drawing={drawing} x={x} row={i + 2} />
          </Fragment>
        ))}
        <div
          className="lane-label lane-database"
          style={{ gridRow: hosts.length + 2 }}
          aria-hidden="true"
        >
          database
        </div>
        <DatabaseLane faults={database} x={x} row={hosts.length + 2} />
        <div className="overlay" style={{ gridRow: `2 / span ${String(hosts.length + 1)}` }}>
          {drawing.quietFrom < endMs && (
            <div className="quiet" style={{ left: pct(drawing.quietFrom), right: 0 }} />
          )}
          {mark !== undefined && (
            <div
              className="mark"
              role="img"
              aria-label={`The moment it broke, at ${clock(mark.time)}`}
              style={{
                left: pct(mark.time),
                width: `max(2px, calc(${pct(mark.until ?? mark.time)} - ${pct(mark.time)}))`,
              }}
            />
          )}
          <div className="scrub" style={{ left: pct(time) }} />
        </div>
      </div>

      <div className="scrubber">
        <input
          type="range"
          min={0}
          max={endMs}
          step={10}
          value={time}
          aria-label="Time in the run"
          aria-valuetext={clock(time)}
          onChange={(e) => {
            setTime(Number(e.target.value));
          }}
        />
        <output aria-label="Time shown">{clock(time)}</output>
        {mark !== undefined && (
          <button
            type="button"
            onClick={() => {
              setTime(mark.time);
            }}
          >
            Go to the moment it broke
          </button>
        )}
      </div>
      <p className="now" aria-live="polite">
        At {clock(time)}: {now}.
      </p>

      {mark !== undefined && (
        <p className="broke">
          <strong>
            It broke at {clock(mark.time)}. {mark.sentence}
          </strong>{' '}
          <span className="invariant">
            {mark.invariant}: {mark.message}
          </span>
        </p>
      )}

      <div className="run-text">
        <section className="faults" aria-label="What went wrong on purpose">
          <h4>What went wrong on purpose</h4>
          {drawing.faults.length === 0 ? (
            <p>Nothing: this run had no faults at all.</p>
          ) : (
            <ol>
              {drawing.faults.map((f) => (
                <li key={f.index} className={f.from <= time ? 'past' : 'ahead'}>
                  <time>{clock(f.from)}</time> {f.text}
                </li>
              ))}
            </ol>
          )}
        </section>
        <section className="log" aria-label="What happened">
          <h4>What happened</h4>
          <ol ref={logRef}>
            {seen.map((l, i) => (
              <li key={`${String(l.time)} ${String(i)}`} className={`tone-${l.tone}`}>
                <time>{clock(l.time)}</time> {l.text}
              </li>
            ))}
          </ol>
        </section>
      </div>
      <figcaption>
        Seed {drawing.seed}, <a href="#modes">{drawing.mode} mode</a>: {drawing.outcomes.ok}{' '}
        requests answered, {drawing.outcomes.failed} refused or failed, {drawing.outcomes.unknown}{' '}
        timed out.
      </figcaption>
    </figure>
  );
}
