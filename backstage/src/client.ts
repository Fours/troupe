// What the UI talks to. The in-process source implements it as it is, and http-client.ts over
// HTTP, so the demo page and `serveBackstage` run the same UI.

import type { BackstageRequest, BackstageResponse, Frame } from '@kylewillett/troupe/backstage';

/** A connection to one system's Backstage source, wherever it runs. */
export interface BackstageClient {
  /**
   * Calls `listener` with a `hello`, then a frame for every event. Another `hello` means a new
   * connection, or a new system: the UI starts over from it.
   * @returns A function that ends the connection.
   */
  connect(listener: (frame: Frame) => void): () => void;
  /** Answers one read-only request. Never rejects: a failure is an error response. */
  request(req: BackstageRequest): Promise<BackstageResponse>;
}
