import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../src/app.js';
import { PostgresStore } from '../src/middlewares/rate-limit.js';
import {
  countingPool,
  createCaptureLogger,
  JSON_HEADERS,
  resetDatabase,
  startTestDatabase,
  startTestServer,
  testConfig,
  waitUntil,
  type TestDatabase,
  type TestServer,
} from './helpers.js';
import type { Config } from '../src/config.js';

let db: TestDatabase;
const servers: TestServer[] = [];

before(async () => {
  db = await startTestDatabase();
});

after(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await db.close();
});

beforeEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await resetDatabase(db.pool);
});

async function serve(options: { config?: Partial<Config>; pool?: TestDatabase['pool']; random?: () => number } = {}) {
  const server = await startTestServer(
    createApp({
      pool: options.pool ?? db.pool,
      config: testConfig(options.config),
      logger: createCaptureLogger().logger,
      random: options.random,
    }),
  );
  servers.push(server);
  return server;
}

const post = (url: string, headers: Record<string, string> = {}) =>
  fetch(`${url}/api/anything`, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: '{}' });

async function statusOf(response: Promise<Response>): Promise<number> {
  const result = await response;
  await result.body?.cancel();
  return result.status;
}

describe('write rate limit (Postgres)', () => {
  test('rejects with 429 RATE_LIMITED and standard headers once the limit is reached', async () => {
    const server = await serve({ config: { rateLimit: { writeMax: 2 } as Config['rateLimit'] } });
    assert.equal(await statusOf(post(server.url)), 404);
    assert.equal(await statusOf(post(server.url)), 404);
    const limited = await post(server.url);
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get('ratelimit-policy') ?? '', /"writes"; q=2; w=60/);
    assert.match(limited.headers.get('ratelimit') ?? '', /"writes"; r=0; t=\d+/);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const body = (await limited.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'RATE_LIMITED');
  });

  test('the counter is shared by every instance', async () => {
    const config = { rateLimit: { writeMax: 3 } as Config['rateLimit'] };
    const first = await serve({ config });
    const second = await serve({ config });
    assert.equal(await statusOf(post(first.url)), 404);
    assert.equal(await statusOf(post(second.url)), 404);
    assert.equal(await statusOf(post(first.url)), 404);
    assert.equal(await statusOf(post(second.url)), 429);
  });

  test('a new window starts after the previous one expires', async () => {
    const server = await serve({ config: { rateLimit: { writeMax: 1, windowMs: 300 } as Config['rateLimit'] } });
    assert.equal(await statusOf(post(server.url)), 404);
    assert.equal(await statusOf(post(server.url)), 429);
    await sleep(400);
    assert.equal(await statusOf(post(server.url)), 404);
  });

  test('stores a SHA-256 of the IP, never the raw address', async () => {
    const server = await serve();
    await statusOf(post(server.url));
    const { rows } = await db.pool.query<{ key: string; hits: number }>('SELECT key, hits FROM rate_limits');
    assert.equal(rows.length, 1);
    const expected = createHash('sha256').update('127.0.0.1').digest('hex');
    assert.equal(rows[0]?.key, `writes:${expected}`);
    assert.equal(rows[0]?.hits, 1);
    assert.doesNotMatch(rows[0]!.key, /127\.0\.0\.1/);
  });

  test('ignores X-Forwarded-For without trust proxy', async () => {
    const server = await serve({ config: { rateLimit: { writeMax: 1 } as Config['rateLimit'] } });
    assert.equal(await statusOf(post(server.url, { 'X-Forwarded-For': '203.0.113.1' })), 404);
    assert.equal(await statusOf(post(server.url, { 'X-Forwarded-For': '203.0.113.2' })), 429);
  });

  test('with trust proxy (Vercel) keys on the X-Forwarded-For client', async () => {
    const server = await serve({ config: { trustProxy: true, rateLimit: { writeMax: 1 } as Config['rateLimit'] } });
    assert.equal(await statusOf(post(server.url, { 'X-Forwarded-For': '203.0.113.1' })), 404);
    assert.equal(await statusOf(post(server.url, { 'X-Forwarded-For': '203.0.113.2' })), 404);
    assert.equal(await statusOf(post(server.url, { 'X-Forwarded-For': '203.0.113.1' })), 429);
    const { rows } = await db.pool.query<{ key: string }>('SELECT key FROM rate_limits ORDER BY key');
    const hash = (ip: string) => `writes:${createHash('sha256').update(ip).digest('hex')}`;
    assert.deepEqual(rows.map((row) => row.key).sort(), [hash('203.0.113.1'), hash('203.0.113.2')].sort());
  });

  test('groups IPv6 clients by /56 subnet', async () => {
    const server = await serve({ config: { trustProxy: true, rateLimit: { writeMax: 1 } as Config['rateLimit'] } });
    assert.equal(await statusOf(post(server.url, { 'X-Forwarded-For': '2001:db8:0:1::1' })), 404);
    assert.equal(await statusOf(post(server.url, { 'X-Forwarded-For': '2001:db8:0:2::9' })), 429);
  });

  test('cleans up expired rows probabilistically', async () => {
    await db.pool.query(
      `INSERT INTO rate_limits (key, hits, reset_at) VALUES ('writes:old', 5, now() - interval '1 minute')`,
    );
    const server = await serve({ random: () => 0 });
    assert.equal(await statusOf(post(server.url)), 404);
    // The cleanup runs in the background, after the response.
    await waitUntil(async () => (await db.pool.query(`SELECT 1 FROM rate_limits WHERE key = 'writes:old'`)).rowCount === 0);
    const { rows } = await db.pool.query<{ key: string }>('SELECT key FROM rate_limits');
    assert.equal(rows.length, 1);
  });

  test('keeps expired rows when the cleanup is not drawn', async () => {
    await db.pool.query(
      `INSERT INTO rate_limits (key, hits, reset_at) VALUES ('writes:old', 5, now() - interval '1 minute')`,
    );
    const server = await serve({ random: () => 0.5 });
    await statusOf(post(server.url));
    const { rows } = await db.pool.query('SELECT key FROM rate_limits');
    assert.equal(rows.length, 2);
  });

  test('a request does not wait for the cleanup', async () => {
    let finishCleanup!: () => void;
    const store = new PostgresStore({
      pool: new Proxy(db.pool, {
        get(target, property) {
          if (property === 'query') {
            return (text: string, values?: unknown[]) =>
              text.startsWith('DELETE')
                ? new Promise((resolve) => {
                    finishCleanup = () => resolve({ rows: [], rowCount: 0 });
                  })
                : target.query(text, values);
          }
          return Reflect.get(target, property);
        },
      }),
      prefix: 'slow',
      logger: createCaptureLogger().logger,
      random: () => 0,
    });
    // The DELETE never finishes until finishCleanup(): increment must resolve anyway.
    const result = await Promise.race([
      store.increment('k'),
      sleep(1_000).then(() => assert.fail('increment() waited for the cleanup')),
    ]);
    assert.equal(result.totalHits, 1);
    finishCleanup();
    await store.lastCleanup;
  });

  test('a failed cleanup is logged and does not fail the request', async () => {
    const capture = createCaptureLogger();
    const store = new PostgresStore({
      pool: new Proxy(db.pool, {
        get(target, property) {
          if (property === 'query') {
            return (text: string, values?: unknown[]) =>
              text.startsWith('DELETE') ? Promise.reject(new Error('cleanup broke')) : target.query(text, values);
          }
          return Reflect.get(target, property);
        },
      }),
      prefix: 'test',
      logger: capture.logger,
      random: () => 0,
    });
    const result = await store.increment('k');
    assert.equal(result.totalHits, 1);
    await store.lastCleanup;
    assert.equal(capture.entries[0]?.event, 'rate_limit_cleanup_failed');
  });
});

describe('PostgresStore', () => {
  test('increments, decrements without going below zero, and resets', async () => {
    const store = new PostgresStore({ pool: db.pool, prefix: 'unit', logger: createCaptureLogger().logger, random: () => 1 });
    store.init({ windowMs: 60_000 } as Parameters<PostgresStore['init']>[0]);
    assert.equal((await store.increment('a')).totalHits, 1);
    const second = await store.increment('a');
    assert.equal(second.totalHits, 2);
    assert.ok(second.resetTime instanceof Date && second.resetTime.getTime() > Date.now());
    await store.decrement('a');
    await store.decrement('a');
    await store.decrement('a');
    const { rows } = await db.pool.query<{ hits: number }>(`SELECT hits FROM rate_limits WHERE key = 'unit:a'`);
    assert.equal(rows[0]?.hits, 0);
    await store.resetKey('a');
    assert.equal((await db.pool.query(`SELECT 1 FROM rate_limits WHERE key = 'unit:a'`)).rowCount, 0);
  });
});

describe('read rate limit (memory)', () => {
  test('limits reads per instance without touching the database', async () => {
    const counting = countingPool(db.pool);
    const server = await serve({
      pool: counting.pool,
      config: { rateLimit: { readMax: 2 } as Config['rateLimit'] },
    });
    assert.equal(await statusOf(fetch(`${server.url}/api/anything`)), 404);
    assert.equal(await statusOf(fetch(`${server.url}/api/anything`)), 404);
    const limited = await fetch(`${server.url}/api/anything`);
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get('ratelimit-policy') ?? '', /"reads"; q=2/);
    await limited.body?.cancel();
    assert.equal(counting.count(), 0);
  });

  test('with a session cookie, limited reads still never reach the database', async () => {
    const counting = countingPool(db.pool);
    const server = await serve({ pool: counting.pool, config: { rateLimit: { readMax: 1 } as Config['rateLimit'] } });
    const headers = { Cookie: `sid=${'A'.repeat(43)}` };
    assert.equal(await statusOf(fetch(`${server.url}/api/auth/session`, { headers })), 200);
    const afterFirst = counting.count();
    assert.ok(afterFirst >= 1, 'the first read looked the session up');
    assert.equal(await statusOf(fetch(`${server.url}/api/auth/session`, { headers })), 429);
    assert.equal(counting.count(), afterFirst);
  });

  test('the health check is outside every limit', async () => {
    const server = await serve({ config: { rateLimit: { readMax: 1, writeMax: 1 } as Config['rateLimit'] } });
    for (let i = 0; i < 5; i++) {
      assert.equal(await statusOf(fetch(`${server.url}/api/health`)), 200);
    }
    assert.equal(await statusOf(fetch(`${server.url}/api/health`, { method: 'POST' })), 405);
    assert.equal(await statusOf(fetch(`${server.url}/api/health`, { method: 'POST' })), 405);
  });

  test('writes do not count as reads', async () => {
    const server = await serve({ config: { rateLimit: { readMax: 1 } as Config['rateLimit'] } });
    assert.equal(await statusOf(post(server.url)), 404);
    assert.equal(await statusOf(post(server.url)), 404);
    assert.equal(await statusOf(fetch(`${server.url}/api/anything`)), 404);
  });
});
