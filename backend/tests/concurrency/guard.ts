// What keeps `npm run test:concurrency` away from real data: the scenarios drop tables, so the
// target comes only from a git-ignored file (never the shell or .env), and a database with
// users is refused unless an earlier run of this suite left its marker there.
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import pg from 'pg';

export const ENV_FILE = '.env.concurrency.local';
export const MARKER = 'concurrency_test_marker';

export function readTargetUrl(file: string = ENV_FILE): string {
  if (!existsSync(file)) throw new Error(`Create backend/${ENV_FILE} with DATABASE_URL=<a test database>.`);
  const url = parseEnv(readFileSync(file, 'utf8')).DATABASE_URL;
  if (!url) throw new Error(`backend/${ENV_FILE} has no DATABASE_URL.`);
  return url;
}

/**
 * The host alone, which identifies a Neon branch. A malformed URL is refused without repeating it:
 * `new URL` accepts some of them and leaves the password in another part, such as the path.
 */
export function describeTarget(connectionString: string): string {
  const url = URL.parse(connectionString);
  const afterHost = `${url?.pathname}${url?.search}${url?.hash}`;
  if (!url || !/^postgres(ql)?:$/.test(url.protocol) || !url.hostname || afterHost.includes('@')) {
    throw new Error(`The DATABASE_URL in backend/${ENV_FILE} is not a valid URL.`);
  }
  return url.hostname;
}

/** Refuses a database that holds users, then marks this one as a test database. */
export async function claimTestDatabase(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // Without a schema name, so these are the tables the scenarios would use and drop.
    const { rows } = await client.query<{ marker: string | null; users: string | null }>(
      `SELECT to_regclass('${MARKER}') AS marker, to_regclass('users') AS users`,
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
