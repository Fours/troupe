// Backstage for opening night: one in-process source per system. A restart makes a new system, so
// the client closes the old source, attaches a new one before the new system's actors spawn, and
// connects everyone again, which hands each of them a fresh hello, as a reconnect would.
import { backstage, type BackstageSource, type Frame } from '@kylewillett/troupe/backstage';
import type { BackstageClient } from '../../../backstage/src/client.ts';
import type { OpeningNight } from './opening-night.ts';

/** A {@link BackstageClient} that follows the night across restarts. */
export interface NightClient extends BackstageClient {
  /** Closes the source. Every connection ends. */
  close(): void;
}

/** Attaches Backstage to `night`, now and after every restart. */
export function nightClient(night: OpeningNight): NightClient {
  const connections = new Map<(frame: Frame) => void, () => void>();
  let source: BackstageSource | undefined;
  const stop = night.onSystem((system) => {
    source?.close();
    const next = backstage(system);
    source = next;
    for (const listener of connections.keys()) connections.set(listener, next.connect(listener));
  });
  // onSystem has called back already.
  const current = (): BackstageSource => {
    if (source === undefined) throw new Error('nightClient: no system yet');
    return source;
  };

  return {
    connect(listener) {
      // A copy per connection, so connecting one listener twice gives two connections.
      const own = (frame: Frame) => {
        listener(frame);
      };
      connections.set(own, current().connect(own));
      return () => {
        connections.get(own)?.();
        connections.delete(own);
      };
    },
    request: (req) => current().request(req),
    close() {
      stop();
      connections.clear();
      source?.close();
    },
  };
}
