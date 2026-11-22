import { useState } from 'react';
import { SPEEDS, type Speed } from './domain/clock.ts';
import { RUSH_SIZE } from './domain/crowd.ts';
import { DEFAULT_TARGET } from './domain/opening-night.ts';
import { useOpeningNight } from './useOpeningNight.ts';

const SPEED_LABELS: Record<Speed, string> = { 0: 'Paused', 0.25: '¼×', 1: '1×', 4: '4×' };

/** Virtual ms as m:ss.t */
function showtime(ms: number): string {
  const tenths = Math.floor(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${String(minutes)}:${seconds.toFixed(1).padStart(4, '0')}`;
}

/**
 * The plain demo page: what's happening in words, the buttons, and a log. Backstage replaces the
 * log in T5.
 */
export function App() {
  const [speed, setSpeed] = useState<Speed>(1);
  const { night, view } = useOpeningNight(1, speed);
  const [journalDown, setJournalDown] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const ready = night !== undefined && !restarting;

  return (
    <main>
      <header>
        <h1>Opening night</h1>
        <p className="lede">
          A real Troupe actor system is running in this page, with no server. Customers arrive at
          the box office, hold seats for one of four shows, then buy them or walk away. Each show is
          an actor that keeps its sales in a journal, so when it crashes, it comes back with
          everything it had.
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
          <button type="button" disabled={!ready} onClick={() => void night?.badRequest()}>
            Bad request
          </button>
          <button
            type="button"
            disabled={!ready}
            aria-pressed={journalDown}
            onClick={() => {
              if (night === undefined) return;
              const next = !journalDown;
              setJournalDown(next);
              void (next ? night.journalDown() : night.journalUp());
            }}
          >
            Journal down
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => {
              if (night === undefined) return;
              setRestarting(true);
              void night.restart().finally(() => {
                setRestarting(false);
              });
            }}
          >
            Restart the system
          </button>
        </div>
        <p className="hint">
          <strong>Rush</strong> sends {RUSH_SIZE} customers at once, so mailboxes fill.{' '}
          <strong>Bad request</strong> sends {DEFAULT_TARGET} a hold for -1 seats: it crashes, and
          its supervisor restarts it. <strong>Journal down</strong> makes every write and read fail
          until it's back. <strong>Restart the system</strong> starts a new one on the same journal.
        </p>
      </section>

      {view.error !== undefined && (
        <p role="alert" className="error">
          The demo stopped: {view.error}
        </p>
      )}

      <section className="log">
        <h2 id="log-heading">What's happening</h2>
        <ol aria-labelledby="log-heading">
          {view.lines.map((line) => (
            <li key={line.id}>
              <time>{showtime(line.at)}</time> {line.text}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
