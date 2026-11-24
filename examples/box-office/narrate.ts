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
    case 'persisted':
      return event.fromSeq === event.toSeq
        ? `${event.path} persisted event ${String(event.toSeq)}`
        : `${event.path} persisted events ${String(event.fromSeq)} to ${String(event.toSeq)}`;
    case 'recovered':
      if (event.lastSeq === 0) return `${event.path} recovered: its journal is empty`;
      return event.snapshotSeq === 0
        ? `${event.path} recovered to event ${String(event.lastSeq)}`
        : `${event.path} recovered to event ${String(event.lastSeq)}, from a snapshot at ${String(event.snapshotSeq)}`;
    case 'deadLetter':
      return `dead letter for ${event.recipient} (${event.reason})`;
    // Only a subscriber with { messages: true } gets these, and the narrator doesn't ask for them.
    case 'delivered':
      return `${event.path} got message ${String(event.id)}`;
    case 'processed':
      return `${event.path} handled message ${String(event.id)}`;
    // Only a system in a cluster has these, and the box office runs on one node.
    case 'memberUp':
      return `${event.address} joined the cluster`;
    case 'memberLeaving':
      return `${event.address} is leaving the cluster`;
    case 'memberDown':
      return `${event.address} was marked down`;
    case 'memberRemoved':
      return `${event.address} is gone from the cluster`;
    case 'reachability':
      return event.reachable
        ? `${event.address} is reachable again`
        : `${event.address} is unreachable`;
    case 'shardAcquired':
      return `${event.node} took shard ${String(event.shard)} of ${event.entityType}`;
    case 'shardReleased':
      return `${event.node} let go of shard ${String(event.shard)} of ${event.entityType} (${event.reason})`;
  }
}
