// The /persistence/postgres entry point: any runtime with a pg-compatible pool. It never imports
// pg. Export only from here.
export {
  postgresPersistence,
  type PgPool,
  type PgPoolClient,
  type PgQueryable,
  type PostgresPersistence,
} from './postgres.js';
