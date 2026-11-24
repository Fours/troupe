import { useEffect, useState } from 'react';
import type { Speed } from '../domain/clock.ts';
import { messageChannelYield } from '../yield.ts';
import { festivalNight, type FestivalNight } from './domain/festival-night.ts';
import { Narrator } from './domain/narrate.ts';
import { nodeClient, type NodeClient } from './domain/node-client.ts';
import { Stage, type StageView } from './domain/stage.ts';

/** One line of the log. */
export interface LogLine {
  readonly id: number;
  /** Virtual time, in ms. */
  readonly at: number;
  readonly text: string;
}

/** How many lines the log keeps. */
export const LOG_LINES = 80;

/** What the page shows, redrawn at most once per animation frame. */
export interface View {
  readonly now: number;
  /** Newest first. */
  readonly lines: readonly LogLine[];
  readonly stage: StageView;
  readonly error?: string;
}

interface Running {
  readonly night: FestivalNight;
  readonly client: NodeClient;
}

/** The node Backstage shows first: one that runs shows, so the sharding tree is there. */
export const FIRST_PICK = 'node-1';

/**
 * Runs festival night for the page: creates it with Backstage on one node, drives its clock from
 * animation frames, and gathers the log and the cluster map. Made in the effect, so React's
 * strict-mode double run makes and disposes a whole one.
 */
export function useFestivalNight(seed: number, speed: Speed) {
  const [running, setRunning] = useState<Running>();
  const [view, setView] = useState<View>({ now: 0, lines: [], stage: { nodes: [] } });

  useEffect(() => {
    const channel = messageChannelYield();
    const night = festivalNight({ seed, yieldToEventLoop: channel.yieldToEventLoop });
    const client = nodeClient(night, FIRST_PICK);
    const narrator = new Narrator();
    const stage = new Stage(night);
    let lines: readonly LogLine[] = [];
    let nextId = 0;
    let changed = true;
    const unsubscribe = night.subscribe((e) => {
      stage.apply(e);
      const text = narrator.line(e);
      if (text !== undefined) {
        const at = e.kind === 'press' ? e.at : e.event.at;
        lines = [{ id: nextId++, at, text }, ...lines].slice(0, LOG_LINES);
      }
      // Only what the page draws: spawns, stops and node states change the map.
      if (text !== undefined || (e.kind === 'event' && e.event.type !== 'delivered')) {
        changed = true;
      }
    });
    const stopChanges = night.onChange(() => {
      changed = true;
    });

    let frame = 0;
    let last: number | undefined;
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
      night.clock.tick(realMs).then(
        () => {
          busy = false;
          const now = night.clock.now();
          // The clock shows tenths, so a redraw for time alone is needed only every 100 ms.
          if (!changed && Math.floor(now / 100) === Math.floor(lastNow / 100)) return;
          changed = false;
          lastNow = now;
          setView({ now, lines, stage: stage.view() });
        },
        (error: unknown) => {
          cancelAnimationFrame(frame);
          setView({ now: night.clock.now(), lines, stage: stage.view(), error: String(error) });
        },
      );
    };
    frame = requestAnimationFrame(loop);
    setRunning({ night, client });

    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      stopChanges();
      client.close();
      void night.dispose().finally(() => {
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
