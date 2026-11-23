// The Postgres shard store's tables, in the journal's schema or any other the caller names. The
// build writes the default schema's SQL to dist/cluster/postgres/schema.sql, for people who manage
// migrations themselves. Every statement is safe to run again. No imports, so the build's
// write-sql script can load it from src/ with type stripping.

/**
 * The statements that create the shard store's schema and tables, if they're missing. Separate
 * statements, because a pool that only speaks the extended query protocol runs one per query.
 */
export function shardStoreSchemaStatements(schema: string): string[] {
  const s = `"${schema}"`;
  return [
    `CREATE SCHEMA IF NOT EXISTS ${s}`,
    `CREATE TABLE IF NOT EXISTS ${s}.shard_leases (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  -- Up by one every time the lease changes hands. A released lease keeps its row, so it never
  -- goes back to 1.
  token BIGINT NOT NULL,
  -- On the database's clock, clock_timestamp(), never a node's (decision 0029). A released lease
  -- expires at -infinity.
  expires_at TIMESTAMPTZ NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS ${s}.remembered_entities (
  shard TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (shard, entity_id)
)`,
  ];
}

/** The SQL that creates the shard store's schema and tables in `schema`, as one script. */
export function shardStoreSchemaSql(schema: string): string {
  return `${shardStoreSchemaStatements(schema).join(';\n\n')};\n`;
}
