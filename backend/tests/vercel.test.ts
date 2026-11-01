import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { startLocalDatabase, type LocalDatabase } from '../src/db/local.js';
import vercelEntry, { createVercelHandler } from '../src/vercel.js';
import { createCaptureLogger, JSON_HEADERS } from './helpers.js';

type VercelHandler = ReturnType<typeof createVercelHandler>;

async function serve(handler: VercelHandler): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createHttpServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await handler.close();
    },
  };
}

describe('Vercel Function export', () => {
  test('is an Express app, which Vercel gives the untouched request, and serves through the handler', async () => {
    assert.equal(typeof vercelEntry.listen, 'function');

    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'mysql://app_user:not-a-real-password@db/app';
    const server = createHttpServer(vercelEntry);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(response.status, 503);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'SERVER_MISCONFIGURED');
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('Vercel entry without configuration', () => {
  test('answers 503 SERVER_MISCONFIGURED in JSON and logs the reason without secrets', async () => {
    const capture = createCaptureLogger();
    const handler = createVercelHandler({ DATABASE_URL: 'mysql://app_user:not-a-real-password@db/app' }, capture.logger);
    const server = await serve(handler);
    try {
      const response = await fetch(`${server.url}/api/health`);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('retry-after'), '60');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'SERVER_MISCONFIGURED');
      const logged = capture.entries.find((entry) => entry.event === 'server_misconfigured');
      assert.ok(logged);
      assert.match(JSON.stringify(logged.fields), /DATABASE_URL/);
      assert.doesNotMatch(JSON.stringify(capture.entries), /not-a-real-password/);
    } finally {
      await server.close();
    }
  });

  test('a missing DATABASE_URL is a misconfiguration (production is forced)', async () => {
    const handler = createVercelHandler({ NODE_ENV: 'development' }, createCaptureLogger().logger);
    const server = await serve(handler);
    try {
      const response = await fetch(`${server.url}/api/health`);
      assert.equal(response.status, 503);
      await response.body?.cancel();
    } finally {
      await server.close();
    }
  });
});

describe('Vercel entry with a database', () => {
  let local: LocalDatabase;

  before(async () => {
    local = await startLocalDatabase();
  });

  after(async () => {
    await local.close();
  });

  /** One connection per query: the local server takes two, and the handler's pool may need to replace its own. */
  async function inspect<T extends pg.QueryResultRow>(sql: string): Promise<T[]> {
    const client = new pg.Client({ connectionString: local.connectionString });
    await client.connect();
    try {
      return (await client.query<T>(sql)).rows;
    } finally {
      await client.end();
    }
  }

  test('creates the schema lazily on the first request and trusts the Vercel proxy', async () => {
    const tables = async () =>
      (await inspect<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`))[0]!.n;
    const handler = createVercelHandler({ DATABASE_URL: local.connectionString }, createCaptureLogger().logger);
    const server = await serve(handler);
    try {
      assert.equal(await tables(), 0);
      const health = await fetch(`${server.url}/api/health`);
      assert.equal(health.status, 200);
      await health.body?.cancel();
      assert.equal(await tables(), 0, 'the health check does not touch the database');
      const read = await fetch(`${server.url}/api/anything`);
      assert.equal(read.status, 404);
      await read.body?.cancel();
      assert.equal(await tables(), 8);

      const write = await fetch(`${server.url}/api/anything`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'X-Forwarded-For': '198.51.100.23' },
        body: '{}',
      });
      assert.equal(write.status, 404);
      await write.body?.cancel();
      const rows = await inspect<{ key: string }>('SELECT key FROM rate_limits');
      const expected = createHash('sha256').update('198.51.100.23').digest('hex');
      assert.deepEqual(rows, [{ key: `writes:${expected}` }]);
    } finally {
      await server.close();
    }
  });
});

describe('Vercel entry with an unreachable database', () => {
  test('answers 503 SERVICE_UNAVAILABLE and retries the schema on the next request', async () => {
    let connections = 0;
    const dropping = createTcpServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => dropping.listen(0, '127.0.0.1', resolve));
    const { port } = dropping.address() as AddressInfo;
    const capture = createCaptureLogger();
    const handler = createVercelHandler(
      { DATABASE_URL: `postgresql://app_user:not-a-real-password@127.0.0.1:${port}/app` },
      capture.logger,
    );
    const server = await serve(handler);
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const response = await fetch(`${server.url}/api/anything`);
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('retry-after'), '5');
        const body = (await response.json()) as { error: { code: string } };
        assert.equal(body.error.code, 'SERVICE_UNAVAILABLE');
        assert.equal(connections, attempt, `schema creation attempted ${attempt} time(s)`);
      }
      assert.equal(capture.entries.filter((entry) => entry.event === 'request_setup_failed').length, 2);

      const health = await fetch(`${server.url}/api/health`);
      assert.equal(health.status, 200, 'liveness does not depend on the database');
      await health.body?.cancel();
      assert.equal(connections, 2);
    } finally {
      await server.close();
      await new Promise<void>((resolve) => dropping.close(() => resolve()));
    }
  });
});
