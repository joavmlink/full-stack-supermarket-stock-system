import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';
import { startLocalDatabase, type LocalDatabase } from '../src/db/local.js';
import { MARKER, claimTestDatabase, describeTarget, readTargetUrl } from './concurrency/guard.js';

describe('Concurrency suite: choosing its database', () => {
  let database: LocalDatabase;
  let client: pg.Client;

  before(async () => {
    database = await startLocalDatabase();
  });

  after(async () => {
    await database.close();
  });

  beforeEach(async () => {
    client = new pg.Client({ connectionString: database.connectionString });
    await client.connect();
    await client.query(`DROP TABLE IF EXISTS users, ${MARKER}`);
  });

  afterEach(async () => {
    await client.end();
  });

  const markerExists = async () => {
    const { rows } = await client.query<{ marker: string | null }>(`SELECT to_regclass('${MARKER}') AS marker`);
    return rows[0]!.marker !== null;
  };
  const createUsers = (rows: number) =>
    client.query(`CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users SELECT generate_series(1, ${rows});`);

  test('refuses a database with users, changing nothing', async () => {
    await createUsers(3);
    await assert.rejects(claimTestDatabase(database.connectionString), /not a test database/);
    assert.equal(await markerExists(), false);
    const { rows } = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM users');
    assert.equal(rows[0]!.count, 3);
  });

  test('takes an empty database and marks it', async () => {
    await createUsers(0);
    await claimTestDatabase(database.connectionString);
    assert.equal(await markerExists(), true);
  });

  test('takes a database without the table and marks it', async () => {
    await claimTestDatabase(database.connectionString);
    assert.equal(await markerExists(), true);
  });

  test('takes a marked database that has users from an earlier run', async () => {
    await claimTestDatabase(database.connectionString);
    await createUsers(3);
    await claimTestDatabase(database.connectionString);
    assert.equal(await markerExists(), true);
  });

  test('looks for users where the scenarios would find them, not only in public', async () => {
    await client.query('CREATE SCHEMA elsewhere; SET search_path = elsewhere');
    try {
      await createUsers(3);
      await assert.rejects(claimTestDatabase(database.connectionString), /not a test database/);
      assert.equal(await markerExists(), false);
    } finally {
      await client.query('RESET search_path; DROP SCHEMA elsewhere CASCADE');
    }
  });
});

describe('Concurrency suite: reading its target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'concurrency-guard-'));
  const file = join(dir, '.env.test');
  const example = 'postgresql://app_user:not-a-real-password@example.test:5432/branch?sslmode=verify-full';

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('reads the URL from its file and ignores the environment', () => {
    writeFileSync(file, `DATABASE_URL=${example}\n`);
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://elsewhere.test/other';
    try {
      assert.equal(readTargetUrl(file), example);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  test('stops when the file or the variable is missing', () => {
    assert.throws(() => readTargetUrl(join(dir, 'missing')), /Create backend/);
    writeFileSync(file, 'OTHER=1\n');
    assert.throws(() => readTargetUrl(file), /has no DATABASE_URL/);
  });

  test('describes the target by its host alone', () => {
    assert.equal(describeTarget(example), 'example.test');
    assert.equal(describeTarget('postgres://app_user:not-a-real-password@example.test/branch'), 'example.test');
  });

  const malformed = [
    'not a url:not-a-real-password',
    'app_user:not-a-real-password@example.test/branch',
    'postgresql:/app_user:not-a-real-password@example.test/branch',
    'postgresql://app_user:12/not-a-real-password@example.test/branch',
    'postgresql://app_user:12?not-a-real-password@example.test/branch',
    'postgresql://app_user:12#not-a-real-password@example.test/branch',
    'postgresql:not-a-real-password',
    'https://app_user:not-a-real-password@example.test/branch',
  ];
  for (const url of malformed) {
    test(`refuses a malformed URL without repeating it: ${url.replace('not-a-real-password', '<password>')}`, () => {
      assert.throws(
        () => describeTarget(url),
        (error: Error) => /not a valid URL/.test(error.message) && !error.message.includes('not-a-real-password'),
      );
    });
  }
});
