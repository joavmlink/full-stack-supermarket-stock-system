import type pg from 'pg';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { createPool } from './pool.js';

export interface Database {
  pool: pg.Pool;
  close(): Promise<void>;
}

/** Remote Postgres pool size per instance; Neon's pooler multiplexes them. */
const REMOTE_POOL_MAX = 5;

/** Connects to DATABASE_URL, or to an embedded PGlite when it is not set. */
export async function openDatabase(config: Config, logger: Logger): Promise<Database> {
  if (config.databaseUrl !== undefined) {
    const pool = createPool(config.databaseUrl, REMOTE_POOL_MAX, logger);
    return { pool, close: () => pool.end() };
  }
  // Imported lazily: PGlite is a development dependency and never loads in production.
  const { startLocalDatabase } = await import('./local.js');
  const local = await startLocalDatabase(config.pgliteDataDir);
  const pool = createPool(local.connectionString, 1, logger);
  return {
    pool,
    close: async () => {
      await pool.end();
      await local.close();
    },
  };
}
