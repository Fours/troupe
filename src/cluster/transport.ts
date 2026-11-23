// What remoting needs from a network (decision 0026): text frames between addresses, in order per
// connection, at most once. A transport knows nothing about actors, so milestone 5 can swap the
// network underneath without touching remoting.

/** Carries text frames between this node and others. */
export interface Transport {
  /** The address other nodes reach this one at, such as `node-1:2552`. */
  readonly address: string;
  /**
   * Starts accepting connections, and calls `onConnection` with each one. Resolves once other
   * nodes can connect.
   */
  listen(onConnection: (connection: Connection) => void): Promise<void>;
  /** Returns at once. Frames sent before it opens wait for it, in order. */
  connect(address: string): Connection;
  /** Stops listening and closes every connection. */
  close(): Promise<void>;
}

/** One connection between two nodes. Frames arrive in the order they were sent, or not at all. */
export interface Connection {
  /** Never throws. A frame sent on a closed connection is dropped, and `onClose` has said so. */
  send(frame: string): void;
  /** Calls `listener` with each frame that arrives. */
  onFrame(listener: (frame: string) => void): void;
  /**
   * Calls `listener` once, when the connection closes, from either end. `error` says why, when
   * it didn't close cleanly: it never opened, or the other end vanished.
   */
  onClose(listener: (error?: unknown) => void): void;
  /** Closes the connection. Frames already sent are still delivered. */
  close(): void;
}
