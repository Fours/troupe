// The /persistence/postgres entry point: any runtime with a pg-compatible pool. It never imports
// pg. Export only from here.
export { postgresPersistence, type PostgresPersistence } from './postgres.js';
export type { PgPool, PgPoolClient, PgQueryable } from './pool.js';
