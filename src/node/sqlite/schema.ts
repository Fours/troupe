// The SQLite backend's tables. The build also writes this to dist/node/sqlite/schema.sql, for
// people who manage migrations themselves. Every statement is safe to run again.

/** The SQL that creates the SQLite backend's tables, if they're missing. */
export const SQLITE_SCHEMA = `CREATE TABLE IF NOT EXISTS troupe_events (
  -- AUTOINCREMENT never reuses a value, so offsets only increase. Appends hold the write lock,
  -- so they also commit in offset order.
  global_offset INTEGER PRIMARY KEY AUTOINCREMENT,
  persistence_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  version INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  -- JSON text: the event, and its tags as an array in the order they were given
  event TEXT NOT NULL,
  tags TEXT NOT NULL,
  UNIQUE (persistence_id, seq)
);

CREATE TABLE IF NOT EXISTS troupe_event_tags (
  tag TEXT NOT NULL,
  global_offset INTEGER NOT NULL,
  PRIMARY KEY (tag, global_offset)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS troupe_snapshots (
  persistence_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  version INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  state TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS troupe_offsets (
  name TEXT PRIMARY KEY,
  global_offset INTEGER NOT NULL
);
`;
