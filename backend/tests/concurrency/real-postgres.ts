// `npm run test:concurrency -w backend`: the concurrency scenarios on a real Postgres,
// which they change freely. The target is only ever read from .env.concurrency.local
// (gitignored), never from the shell or .env, and must be a database made for this:
// a Neon branch created with "Schema only". The run refuses any database with users,
// unless an earlier run of this suite left its marker there.
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { defineConcurrencyScenarios } from './scenarios.js';

const ENV_FILE = '.env.concurrency.local';
const MARKER = 'concurrency_test_marker';

function readTargetUrl(): string {
  if (!existsSync(ENV_FILE)) throw new Error(`Create backend/${ENV_FILE} with DATABASE_URL=<a test database>.`);
  const url = parseEnv(readFileSync(ENV_FILE, 'utf8')).DATABASE_URL;
  if (!url) throw new Error(`backend/${ENV_FILE} has no DATABASE_URL.`);
  return url;
}

/** Refuses a database that holds real accounts, then marks this one as a test database. */
async function claimTestDatabase(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{ marker: string | null; users: string | null }>(
      `SELECT to_regclass('public.${MARKER}') AS marker, to_regclass('public.users') AS users`,
    );
    if (rows[0]!.marker === null && rows[0]!.users !== null) {
      const existing = await client.query('SELECT 1 FROM users LIMIT 1');
      if (existing.rowCount !== 0) {
        throw new Error('This database has users, so it is not a test database. Nothing was changed.');
      }
    }
    await client.query(`CREATE TABLE IF NOT EXISTS ${MARKER} (id boolean PRIMARY KEY DEFAULT true)`);
  } finally {
    await client.end();
  }
}

defineConcurrencyScenarios({
  instances: 2,
  poolSize: 5,
  realSessions: true,
  // A request takes about a second from a machine far from the database.
  raceStepMs: 200,
  open: async () => {
    const connectionString = readTargetUrl();
    const { host, pathname } = new URL(connectionString);
    console.log(`Target: Postgres at ${host}${pathname}`);
    await claimTestDatabase(connectionString);
    return { connectionString, close: async () => {} };
  },
});
