// The Backstage client for `serveBackstage`: frames from server-sent events, requests as JSON
// posts (decision 0023). EventSource reconnects by itself, and the server greets every new
// connection with a fresh hello, so the UI starts over from it as it would after a restart.

import type { BackstageRequest, BackstageResponse, Frame } from '@kylewillett/troupe/backstage';
import type { BackstageClient } from './client.ts';

/** Where a connection stands: open, waiting to reconnect, or given up because it was refused. */
export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * A {@link BackstageClient} for the server at `base`, such as `http://127.0.0.1:7070/`.
 * `onStatus` hears each connection's status as it changes.
 */
export function httpClient(
  base: string | URL,
  onStatus: (status: ConnectionStatus) => void = () => undefined,
): BackstageClient {
  const events = new URL('events', base);
  const requests = new URL('request', base);
  return {
    connect(listener) {
      onStatus('connecting');
      const source = new EventSource(events);
      source.onopen = () => {
        onStatus('open');
      };
      // While the server is away, EventSource keeps trying. It gives up only on a refusal, such
      // as a 403 for a Host header the server doesn't answer.
      source.onerror = () => {
        onStatus(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
      };
      source.onmessage = (message: MessageEvent<string>) => {
        let frames: Frame[];
        try {
          frames = JSON.parse(message.data) as Frame[];
        } catch {
          return;
        }
        for (const frame of frames) listener(frame);
      };
      return () => {
        source.close();
      };
    },
    async request(req: BackstageRequest): Promise<BackstageResponse> {
      try {
        const res = await fetch(requests, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
        });
        return (await res.json()) as BackstageResponse;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: { name: 'NetworkError', message } };
      }
    },
  };
}
