import { testPool } from '../helpers/postgres.js';

/**
 * Runs once before the integration tests. Fails loudly rather than skipping, so a run with no
 * database can never look like a pass.
 */
export default async function setup(): Promise<void> {
  // Throws first if CI is set without TROUPE_POSTGRES_URL.
  const pool = testPool({ max: 1, connectionTimeoutMillis: 3_000 });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    throw new Error(
      'No Postgres for the integration tests. Start the test database with npm run postgres:up, ' +
        `or set TROUPE_POSTGRES_URL. Cause: ${String(error)}`,
      { cause: error },
    );
  } finally {
    await pool.end();
  }
}
