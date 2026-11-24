// Reading `docker compose logs -t --no-color`, whose lines look like
// `node-1-1  | 2026-11-24T16:19:59.444169553Z {"ev":"up",...}`.

/** One line of a service's output, with when Docker says it was written. */
export interface ComposeLine {
  /** The service, without the container's index: `node-1`, not `node-1-1`. */
  readonly service: string;
  /** Milliseconds since the epoch. */
  readonly at: number;
  readonly text: string;
}

const LINE = /^(\S+?)-\d+\s+\|\s(\d{4}-\d\d-\d\dT[\d:.]+Z)\s?(.*)$/;

/** Reads one line, or `undefined` for anything else, such as compose's own messages. */
export function parseComposeLine(raw: string): ComposeLine | undefined {
  const match = LINE.exec(raw);
  if (match === null) return undefined;
  const [, service = '', time = '', text = ''] = match;
  const at = Date.parse(time);
  return Number.isNaN(at) ? undefined : { service, at, text };
}
