// The Postgres backend's tables, in a schema the caller names. The build writes the default
// schema's SQL to dist/persistence/postgres/schema.sql, for people who manage migrations
// themselves. Every statement is safe to run again.

/** The schema the Postgres backend uses when none is given. */
export const DEFAULT_SCHEMA = 'troupe';

// Lower case only, so quoting the name never changes what it means, and short enough for
// Postgres's 63-byte identifier limit.
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/** Whether `name` can be a schema name: lower-case letters, digits and `_`, at most 63. */
export function isSchemaName(name: unknown): name is string {
  return typeof name === 'string' && SCHEMA_PATTERN.test(name);
}

/**
 * The statements that create the backend's schema and tables, if they're missing. Separate
 * statements rather than one string, because a pool that only speaks the extended query protocol
 * runs one statement per query.
 */
export function postgresSchemaStatements(schema: string): string[] {
  const s = `"${schema}"`;
  return [
    `CREATE SCHEMA IF NOT EXISTS ${s}`,
    `CREATE TABLE IF NOT EXISTS ${s}.events (
  -- An identity never hands out a value twice, so offsets only increase. Appends take the
  -- journal's advisory lock before they draw one, so offsets also commit in order (decision 0016).
  global_offset BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  persistence_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  version BIGINT NOT NULL,
  timestamp BIGINT NOT NULL,
  -- json, not jsonb: it keeps the text as written, so it accepts every JSON value the other
  -- backends do. jsonb rejects \\u0000 and lone surrogates. Tags are an array in the order given.
  event JSON NOT NULL,
  tags JSON NOT NULL,
  UNIQUE (persistence_id, seq)
)`,
    `CREATE TABLE IF NOT EXISTS ${s}.event_tags (
  tag TEXT NOT NULL,
  global_offset BIGINT NOT NULL,
  PRIMARY KEY (tag, global_offset)
)`,
    `CREATE TABLE IF NOT EXISTS ${s}.snapshots (
  persistence_id TEXT PRIMARY KEY,
  seq BIGINT NOT NULL,
  version BIGINT NOT NULL,
  timestamp BIGINT NOT NULL,
  state JSON NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS ${s}.offsets (
  name TEXT PRIMARY KEY,
  global_offset BIGINT NOT NULL
)`,
  ];
}

/** The SQL that creates the backend's schema and tables, as one script. */
export function postgresSchemaSql(schema: string = DEFAULT_SCHEMA): string {
  return `${postgresSchemaStatements(schema).join(';\n\n')};\n`;
}
