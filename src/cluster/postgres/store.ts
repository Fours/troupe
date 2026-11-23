import { checkKeys, checkId, describe } from '../../checks.js';
import {
  checkPool,
  LOCK,
  LOCK_CLASS,
  schemaHash,
  toInt,
  transaction,
  type PgPool,
} from '../../persistence/postgres/pool.js';
import { DEFAULT_SCHEMA, isSchemaName } from '../../persistence/postgres/schema.js';
import {
  byText,
  checkAcquire,
  checkEntity,
  checkPrefix,
  checkRelease,
  checkRenewAll,
  type AcquireResult,
  type LeaseHolder,
  type ShardStore,
} from '../shard-store.js';
import { shardStoreSchemaStatements } from './schema.js';

/** The Postgres shard store, on the caller's pool. */
export interface PostgresShardStore extends ShardStore {
  /**
   * Creates the schema and tables if they're missing. Safe to run on every start, from several
   * processes at once, and alongside the journal's `setup()` on the same schema. Skip it if you
   * manage migrations yourself: the SQL ships as `dist/cluster/postgres/schema.sql`.
   */
  setup(): Promise<void>;
}

const OPTIONS = new Set(['pool', 'schema']);

// A loser reads the winner back. If the lease was released or expired in between, it tries again,
// a few times at most, then reports whoever holds the row.
const ACQUIRE_ATTEMPTS = 3;

/**
 * A shard store on Postgres, through the caller's own `pg`-compatible pool, so it adds no
 * dependency and runs wherever the pool does (decision 0017). Its tables can share a schema with
 * the journal's. Call `setup()` once to create them, or create them yourself.
 *
 * Expiry is judged on the database's own clock, `clock_timestamp()`, never a node's (decision
 * 0029). An acquire is one `INSERT ... ON CONFLICT DO UPDATE` whose condition Postgres checks again
 * under the row's lock, so two nodes racing for a lease can't both win, in one process or many.
 *
 * @param opts.pool The pool to run on. The store never ends it.
 * @param opts.schema The schema for the tables: lower-case letters, digits and `_`. Default
 *   `troupe`, the journal's.
 */
export function postgresShardStore(opts: { pool: PgPool; schema?: string }): PostgresShardStore {
  checkKeys(opts, OPTIONS, 'postgresShardStore');
  const { pool, schema = DEFAULT_SCHEMA } = opts;
  checkPool(pool, 'postgresShardStore');
  if (!isSchemaName(schema)) {
    throw new TypeError(
      'postgresShardStore: schema must be lower-case letters, digits and _, starting with a ' +
        `letter or _, at most 63, got ${describe(schema)}`,
    );
  }
  const s = `"${schema}"`;
  const lockKey = schemaHash(schema);

  const EXPIRY = `clock_timestamp() + $3::double precision * interval '1 millisecond'`;
  // The WHERE runs again once the row's lock is free, against what the other writer committed,
  // so it decides every race. A lease still this holder's keeps its token. Any other change of
  // hands, back to the same holder included, raises it.
  const ACQUIRE = `INSERT INTO ${s}.shard_leases AS l (name, holder, token, expires_at)
    VALUES ($1, $2, 1, ${EXPIRY})
    ON CONFLICT (name) DO UPDATE SET
      token = CASE WHEN l.holder = excluded.holder AND l.expires_at > clock_timestamp()
        THEN l.token ELSE l.token + 1 END,
      holder = excluded.holder,
      expires_at = excluded.expires_at
    WHERE l.holder = excluded.holder OR l.expires_at <= clock_timestamp()
    RETURNING token`;
  const HOLDER = `SELECT holder, expires_at > clock_timestamp() AS live
    FROM ${s}.shard_leases WHERE name = $1`;
  const RENEW = `UPDATE ${s}.shard_leases SET expires_at = clock_timestamp() + $2::double precision
      * interval '1 millisecond'
    WHERE holder = $1 AND expires_at > clock_timestamp()
    RETURNING name`;
  const RELEASE = `UPDATE ${s}.shard_leases SET expires_at = '-infinity'
    WHERE name = $1 AND holder = $2 AND token = $3`;
  // COLLATE "C" sorts by code point, as the in-memory store does, whatever the database's locale.
  const HOLDERS = `SELECT name, holder FROM ${s}.shard_leases
    WHERE starts_with(name, $1) AND expires_at > clock_timestamp() ORDER BY name COLLATE "C"`;
  const REMEMBER = `INSERT INTO ${s}.remembered_entities (shard, entity_id) VALUES ($1, $2)
    ON CONFLICT DO NOTHING`;
  const FORGET = `DELETE FROM ${s}.remembered_entities WHERE shard = $1 AND entity_id = $2`;
  const REMEMBERED = `SELECT entity_id FROM ${s}.remembered_entities WHERE shard = $1
    ORDER BY entity_id COLLATE "C"`;

  async function rows<T>(text: string, values: unknown[]): Promise<T[]> {
    const result = await pool.query(text, values);
    return result.rows as T[];
  }

  return {
    async acquire(lease, holder, ttlMs) {
      checkAcquire(lease, holder, ttlMs);
      // In a read-committed transaction, whatever the database's default, so the upsert waits for
      // a racing one instead of failing to serialize, and the read after it sees the winner.
      return await transaction(pool, async (client): Promise<AcquireResult> => {
        let holderNow = '';
        for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
          const [won] = (await client.query(ACQUIRE, [lease, holder, ttlMs])).rows as {
            token: unknown;
          }[];
          if (won !== undefined) return { acquired: true, token: toInt(won.token) };
          const [row] = (await client.query(HOLDER, [lease])).rows as {
            holder: string;
            live: boolean;
          }[];
          if (row === undefined) continue;
          holderNow = row.holder;
          if (row.live) break;
        }
        return { acquired: false, holder: holderNow };
      });
    },

    async renewAll(holder, ttlMs) {
      checkRenewAll(holder, ttlMs);
      // In a transaction for read committed, as acquire is, so it can't fail to serialize.
      const renewed = await transaction(
        pool,
        async (client) => (await client.query(RENEW, [holder, ttlMs])).rows as { name: string }[],
      );
      return renewed.map((r) => r.name).sort(byText);
    },

    async release(lease, holder, token) {
      checkRelease(lease, holder, token);
      await pool.query(RELEASE, [lease, holder, token]);
    },

    async holders(prefix) {
      checkPrefix(prefix);
      const found = await rows<{ name: string; holder: string }>(HOLDERS, [prefix]);
      return found.map((r): LeaseHolder => ({ lease: r.name, holder: r.holder }));
    },

    async remember(shard, id) {
      checkEntity(shard, id, 'remember');
      await pool.query(REMEMBER, [shard, id]);
    },

    async forget(shard, id) {
      checkEntity(shard, id, 'forget');
      await pool.query(FORGET, [shard, id]);
    },

    async remembered(shard) {
      checkId(shard, 'remembered: shard');
      return (await rows<{ entity_id: string }>(REMEMBERED, [shard])).map((r) => r.entity_id);
    },

    async setup() {
      // Under the schema's advisory lock, which the journal's setup() takes too, so neither races
      // the other, or itself in another process, to create the schema.
      await transaction(pool, async (client) => {
        await client.query(LOCK, [LOCK_CLASS, lockKey]);
        for (const statement of shardStoreSchemaStatements(schema)) await client.query(statement);
      });
    },
  };
}
