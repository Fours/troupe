// The /cluster/postgres entry point: any runtime with a pg-compatible pool. It never imports pg.
// Export only from here.
export { postgresShardStore, type PostgresShardStore } from './store.js';
