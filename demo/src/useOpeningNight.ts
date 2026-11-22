import { useEffect, useState } from 'react';
import { nightClient, type NightClient } from './domain/backstage-client.ts';
import type { Speed } from './domain/clock.ts';
import { narrate } from './domain/narrate.ts';
import { openingNight, type OpeningNight } from './domain/opening-night.ts';
import { messageChannelYield } from './yield.ts';

/** One line of the log. */
export interface LogLine {
  readonly id: number;
  /** Virtual time, in ms. */
  readonly at: number;
  readonly text: string;
}

/** How many lines the log keeps. */
export const LOG_LINES = 60;

/** What the page shows, redrawn at most once per animation frame. */
export interface View {
  readonly now: number;
  /** Newest first. */
  readonly lines: readonly LogLine[];
  readonly error?: string;
}

/** A running night, and Backstage attached to it. */
interface Running {
  readonly night: OpeningNight;
  readonly client: NightClient;
}

/**
 * Runs opening night for the page: creates it with Backstage attached, drives its clock from
 * animation frames, and gathers the log. The night is created in the effect, so React's
 * strict-mode double run makes and disposes a whole one, rather than sharing one that was
 * disposed.
 */
export function useOpeningNight(seed: number, speed: Speed) {
  const [running, setRunning] = useState<Running>();
  const [view, setView] = useState<View>({ now: 0, lines: [] });

  useEffect(() => {
    const channel = messageChannelYield();
    const created = openingNight({ seed, yieldToEventLoop: channel.yieldToEventLoop });
    // Before the clock first moves, so Backstage sees every spawn.
    const client = nightClient(created);
    let lines: readonly LogLine[] = [];
    let nextId = 0;
    let changed = true;
    const unsubscribe = created.subscribe((event) => {
      const text = narrate(event);
      if (text === undefined) return;
      lines = [{ id: nextId++, at: event.at, text }, ...lines].slice(0, LOG_LINES);
      changed = true;
    });

    let frame = 0;
    let last: number | undefined;
    // Real time owed while a tick was still running, given to the next one.
    let owed = 0;
    let busy = false;
    let lastNow = -1;
    const loop = (time: number) => {
      frame = requestAnimationFrame(loop);
      owed += last === undefined ? 0 : time - last;
      last = time;
      if (busy) return;
      busy = true;
      const realMs = owed;
      owed = 0;
      created.clock.tick(realMs).then(
        () => {
          busy = false;
          const now = created.clock.now();
          if (!changed && now === lastNow) return;
          changed = false;
          lastNow = now;
          setView({ now, lines });
        },
        (error: unknown) => {
          cancelAnimationFrame(frame);
          setView({ now: created.clock.now(), lines, error: String(error) });
        },
      );
    };
    frame = requestAnimationFrame(loop);
    setRunning({ night: created, client });

    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      client.close();
      void created.dispose().finally(() => {
        channel.close();
      });
    };
  }, [seed]);

  const night = running?.night;
  useEffect(() => {
    if (night !== undefined) night.clock.speed = speed;
  }, [night, speed]);

  return { night, client: running?.client, view };
}
