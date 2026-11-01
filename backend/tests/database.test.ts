import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { bootstrap } from '../src/bootstrap.js';
import { openDatabase } from '../src/db/database.js';
import { withTransaction, type Queryable } from '../src/db/pool.js';
import { createCaptureLogger, startTestDatabase, startTestServer, testConfig, type TestDatabase } from './helpers.js';

describe('withTransaction', () => {
  let db: TestDatabase;

  before(async () => {
    db = await startTestDatabase();
    await db.pool.query('CREATE TABLE IF NOT EXISTS tx_probe (value int)');
  });

  after(async () => {
    await db.close();
  });

  test('commits the work and releases the client', async () => {
    const result = await withTransaction(db.pool, async (client) => {
      await client.query('INSERT INTO tx_probe VALUES (1)');
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal((await db.pool.query('SELECT * FROM tx_probe')).rowCount, 1);
    assert.equal(db.pool.idleCount, 1);
  });

  test('rolls back on error, rethrows it and releases the client', async () => {
    await db.pool.query('TRUNCATE tx_probe');
    await assert.rejects(
      withTransaction(db.pool, async (client) => {
        await client.query('INSERT INTO tx_probe VALUES (2)');
        throw new Error('abort');
      }),
      { message: 'abort' },
    );
    assert.equal((await db.pool.query('SELECT * FROM tx_probe')).rowCount, 0);
    assert.equal(db.pool.totalCount, 1);
  });

  test('limits each statement and each idle gap of a transaction on the server, and only that transaction', async () => {
    const setting = async (client: Queryable, name: string) =>
      (await client.query<Record<string, string>>(`SHOW ${name}`)).rows[0]?.[name];
    await withTransaction(db.pool, async (client) => {
      assert.equal(await setting(client, 'statement_timeout'), '7s');
      assert.equal(await setting(client, 'idle_in_transaction_session_timeout'), '8s');
    });
    assert.equal(await setting(db.pool, 'statement_timeout'), '0');
    assert.equal(await setting(db.pool, 'idle_in_transaction_session_timeout'), '0');
  });

  test('discards the client when the rollback fails too', async () => {
    let released: unknown = 'not released';
    const client = {
      query: async (text: string) => {
        if (text.startsWith('BEGIN')) return {};
        throw new Error(text === 'ROLLBACK' ? 'connection lost' : 'work failed');
      },
      release: (error?: unknown) => {
        released = error;
      },
    };
    const pool = { connect: async () => client } as unknown as Parameters<typeof withTransaction>[0];
    await assert.rejects(
      withTransaction(pool, async (c) => {
        await c.query('SELECT 1');
      }),
      { message: 'work failed' },
    );
    assert.ok(released instanceof Error);
    assert.equal(released.message, 'connection lost');
  });
});

describe('openDatabase and bootstrap', () => {
  test('bootstrap opens an in-memory PGlite, creates the schema and builds the app', async () => {
    const { app, db } = await bootstrap(testConfig(), createCaptureLogger().logger);
    const server = await startTestServer(app);
    try {
      const response = await fetch(`${server.url}/api/health`);
      assert.equal(response.status, 200);
      await response.body?.cancel();
      const { rows } = await db.pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'products'`);
      assert.equal(rows.length, 1);
    } finally {
      await server.close();
      await db.close();
    }
  });

  test('openDatabase uses DATABASE_URL when set', async () => {
    const local = await startTestDatabase();
    try {
      const db = await openDatabase(testConfig({ databaseUrl: local.connectionString }), createCaptureLogger().logger);
      try {
        assert.equal(db.pool.options.max, 5);
        const { rows } = await db.pool.query<{ ok: number }>('SELECT 1 AS ok');
        assert.equal(rows[0]?.ok, 1);
      } finally {
        await db.close();
      }
    } finally {
      await local.close();
    }
  });

  test('bootstrap closes the pool and rethrows when the schema cannot be created', async () => {
    const dropping = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => dropping.listen(0, '127.0.0.1', resolve));
    const { port } = dropping.address() as AddressInfo;
    try {
      await assert.rejects(
        bootstrap(
          testConfig({ databaseUrl: `postgresql://app_user:not-a-real-password@127.0.0.1:${port}/app` }),
          createCaptureLogger().logger,
        ),
        (error: Error) => /terminated|ECONNRESET/i.test(`${error.message} ${(error as { code?: string }).code}`),
      );
    } finally {
      await new Promise<void>((resolve) => dropping.close(() => resolve()));
    }
  });
});
