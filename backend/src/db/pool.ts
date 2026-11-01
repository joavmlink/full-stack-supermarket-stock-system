import pg from 'pg';
import { logError, type Logger } from '../logger.js';

/**
 * Each timeout stays below the Vercel Function maxDuration (10 s), so one slow or
 * unreachable operation still produces a JSON response. They limit one operation
 * each, not the request: several slow ones in a row can reach maxDuration.
 */
const POOL_TIMEOUTS = Object.freeze({
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  query_timeout: 8_000,
});

/**
 * Server-side limits of a transaction, set inside it because the Neon pooler does
 * not take them as connection parameters. Unlike query_timeout, which only stops
 * waiting, they end the work in Postgres: its row locks are released even when the
 * function was cut off or frozen with the transaction open.
 */
const BEGIN_TRANSACTION = `BEGIN;
  SET LOCAL statement_timeout = '7s';
  SET LOCAL idle_in_transaction_session_timeout = '8s'`;

/** A pool or a client checked out of it (inside a transaction). */
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, max: number, logger: Logger): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, ...POOL_TIMEOUTS });
  // An idle client that loses its connection emits 'error' on the pool; without
  // a listener that would crash the process.
  pool.on('error', (error) => logError(logger, 'db_idle_client_error', error));
  return pool;
}

/** Runs `work` inside a transaction on a dedicated client. */
export async function withTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query(BEGIN_TRANSACTION);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // If the rollback fails too (for example, the connection was cut), the
    // client is discarded instead of going back to the pool.
    await client.query('ROLLBACK').catch((rollbackError: Error) => {
      broken = rollbackError;
    });
    throw error;
  } finally {
    client.release(broken);
  }
}
