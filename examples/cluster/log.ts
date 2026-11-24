// What a festival-night process says: one JSON object per line on stdout, so people can read it
// and the multi-process test and the benchmark can parse it. Each line has `ev`, what happened.
import type { ActorSystem, Logger, SystemEvent } from '@kylewillett/troupe';

/** Writes one line. */
export function emit(line: { readonly ev: string } & Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/** An error's name and message, which is all a line needs and all JSON can carry. */
export function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: typeof error, message: String(error) };
}

function fieldsOf(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (fields === undefined) return {};
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, v instanceof Error ? describeError(v) : v]),
  );
}

/** Warnings and errors, as `log` lines. A `JournalConflictError` would show here, or as `failed`. */
export const jsonLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (msg, fields) => {
    emit({ ev: 'log', level: 'warn', msg, ...fieldsOf(fields) });
  },
  error: (msg, fields) => {
    emit({ ev: 'log', level: 'error', msg, ...fieldsOf(fields) });
  },
};

const CLUSTER_EVENTS = new Set<SystemEvent['type']>([
  'memberUp',
  'memberLeaving',
  'memberDown',
  'memberRemoved',
  'reachability',
  'shardAcquired',
  'shardReleased',
]);

/** Writes every cluster event, and every failure, as a line. */
export function emitEvents(system: ActorSystem): void {
  system.events.subscribe((event) => {
    if (CLUSTER_EVENTS.has(event.type)) {
      emit({ ...event, ev: event.type });
    } else if (event.type === 'failed') {
      emit({
        ev: 'failed',
        path: event.path,
        directive: event.directive,
        error: describeError(event.error),
      });
    }
  });
}
