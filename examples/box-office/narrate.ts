// Turns what happens into one line per step, timestamped from the system's scheduler.
import type { SystemEvent } from '@kylewillett/troupe';

/** Prints the story of a run: the scenario's own lines, and the system's events. */
export interface Narrator {
  /** A line from the scenario, such as what a customer did. */
  say(line: string): void;
  /** A line for a system event. */
  event(event: SystemEvent): void;
}

/**
 * @param now The scheduler's clock. Times are shown from the moment the narrator was created.
 * @param print Where each finished line goes.
 */
export function narrator(now: () => number, print: (line: string) => void): Narrator {
  const start = now();
  const stamp = (at: number) => `${((at - start) / 1000).toFixed(2).padStart(5)}s`;
  return {
    say: (line) => {
      print(`${stamp(now())}  ${line}`);
    },
    event: (event) => {
      print(`${stamp(event.at)}  · ${describe(event)}`);
    },
  };
}

function describe(event: SystemEvent): string {
  switch (event.type) {
    case 'spawned':
      return `${event.path} started`;
    case 'stopped':
      return 'failure' in event
        ? `${event.path} stopped after failing: ${String(event.failure)}`
        : `${event.path} stopped`;
    case 'failed':
      return `${event.path} failed with ${String(event.error)}, so its parent will ${event.directive} it`;
    case 'restarted':
      return `${event.path} restarted after a ${String(event.delayMs)} ms backoff (attempt ${String(event.attempt)})`;
    case 'deadLetter':
      return `dead letter for ${event.recipient} (${event.reason})`;
  }
}
