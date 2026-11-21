/** Log levels, from most to least verbose. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Where the system and `ctx.log` write. Pass your own to `createActorSystem` to route Troupe's
 * logs into your logging library. A logger that throws never affects an actor.
 */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * A logger that writes to `console`, at `level` and above.
 * @param level The lowest level to write. Default `"warn"`.
 * @throws TypeError for an unknown level.
 */
export function consoleLogger(level: LogLevel = 'warn'): Logger {
  const min = LEVELS.indexOf(level);
  if (min === -1) {
    // JSON.stringify, because at runtime a JavaScript caller can pass anything here.
    throw new TypeError(
      `consoleLogger: level must be one of ${LEVELS.join(', ')}, got ${JSON.stringify(level)}`,
    );
  }
  const at =
    (lvl: LogLevel) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      if (LEVELS.indexOf(lvl) < min) return;
      if (fields === undefined) console[lvl](`[troupe] ${msg}`);
      else console[lvl](`[troupe] ${msg}`, fields);
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

const noop = (): void => {};

/** A logger that discards everything. */
export const silentLogger: Logger = Object.freeze({
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
});

/** True if `value` has the four logging methods. */
export function isLogger(value: unknown): value is Logger {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return LEVELS.every((lvl) => typeof v[lvl] === 'function');
}

/**
 * Wraps a caller's logger so it can never throw into the system, and optionally adds fields to
 * every entry, as `ctx.log` adds `{ path }`.
 */
export function safeLogger(logger: Logger, extra?: Record<string, unknown>): Logger {
  const at =
    (lvl: LogLevel) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      try {
        const merged = extra === undefined ? fields : { ...extra, ...fields };
        if (merged === undefined) logger[lvl](msg);
        else logger[lvl](msg, merged);
      } catch {
        // A broken logger must not break an actor, and there's nowhere left to report it.
      }
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
