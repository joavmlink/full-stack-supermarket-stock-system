import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { AppDependencies } from '../src/app.js';
import type { Config } from '../src/config.js';
import { hashPassword } from '../src/lib/password.js';
import { updateEmployee } from '../src/models/user-model.js';
import {
  createCaptureLogger,
  createTestApp,
  expectError,
  insertUser,
  JSON_HEADERS,
  resetDatabase,
  sessionCookieOf,
  sessionUser,
  signIn,
  startTestDatabase,
  startTestServer,
  STRONG_PASSWORD,
  TEST_SCRYPT,
  testConfig,
  waitUntil,
  type TestDatabase,
  type TestServer,
} from './helpers.js';

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

async function serve(config: Partial<Config> = {}, deps: Partial<AppDependencies> = {}) {
  const server = await startTestServer(createTestApp({ pool: db.pool, config: testConfig(config), ...deps }));
  servers.push(server);
  return server;
}

const login = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}/api/auth/login`, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });



describe('POST /api/auth/login', () => {
  test('signs in and sets an httpOnly, SameSite=Strict session cookie', async () => {
    const server = await serve();
    const user = await insertUser(db.pool, { email: 'ana@example.com', fullName: 'Ana Pérez' });
    const response = await login(server.url, { email: '  ANA@Example.com ', password: STRONG_PASSWORD });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), user);
    const cookie = response.headers.get('set-cookie') ?? '';
    assert.match(cookie, /^sid=[A-Za-z0-9_-]{43}; Max-Age=43200; Path=\/; HttpOnly; SameSite=Strict$/);
  });

  test('uses a __Host- Secure cookie in production', async () => {
    const server = await serve({ isProduction: true });
    await insertUser(db.pool, { email: 'ana@example.com' });
    const response = await login(server.url, { email: 'ana@example.com', password: STRONG_PASSWORD });
    const cookie = response.headers.get('set-cookie') ?? '';
    assert.match(cookie, /^__Host-sid=[A-Za-z0-9_-]{43}; .*Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    await response.body?.cancel();
  });

  test('stores only the SHA-256 of the token', async () => {
    const server = await serve();
    await insertUser(db.pool, { email: 'ana@example.com' });
    const cookie = await signIn(server.url, 'ana@example.com');
    const token = cookie.split('=')[1]!;
    const { rows } = await db.pool.query<{ token_hash: Buffer }>('SELECT token_hash FROM sessions');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.token_hash, createHash('sha256').update(token).digest());
  });

  test('a wrong password and an unknown email give the same 401', async () => {
    const server = await serve();
    await insertUser(db.pool, { email: 'ana@example.com' });
    for (const body of [
      { email: 'ana@example.com', password: 'wrong password entirely' },
      { email: 'nobody@example.com', password: STRONG_PASSWORD },
    ]) {
      const error = await expectError(await login(server.url, body), 401, 'INVALID_CREDENTIALS');
      assert.equal(error.message, 'Invalid email or password.');
    }
    assert.equal((await db.pool.query('SELECT 1 FROM sessions')).rowCount, 0);
  });

  for (const [label, body] of [
    ['an extra field', { email: 'ana@example.com', password: 'x', remember: true }],
    ['a missing password', { email: 'ana@example.com' }],
    ['an invalid email', { email: 'not-an-email', password: 'x' }],
    ['an over-long password', { email: 'ana@example.com', password: 'x'.repeat(129) }],
    ['a non-object body', ['ana@example.com']],
  ] as const) {
    test(`rejects ${label} with 400 VALIDATION_ERROR`, async () => {
      const server = await serve();
      const response = await login(server.url, body);
      await expectError(response, 400, 'VALIDATION_ERROR');
    });
  }

  test('replaces the previous session of the same browser (no session fixation)', async () => {
    const server = await serve();
    await insertUser(db.pool, { email: 'ana@example.com' });
    const first = await signIn(server.url, 'ana@example.com');
    const response = await login(server.url, { email: 'ana@example.com', password: STRONG_PASSWORD }, { Cookie: first });
    const second = sessionCookieOf(response);
    await response.body?.cancel();
    assert.notEqual(second, first);
    assert.equal(await sessionUser(server.url, first), null);
    assert.notEqual(await sessionUser(server.url, second), null);
    assert.equal((await db.pool.query('SELECT 1 FROM sessions')).rowCount, 1);
  });

  test('a password changed while the login is being verified gives no session', async () => {
    const user = await insertUser(db.pool, { email: 'ana@example.com' });
    const newHash = await hashPassword('another long passphrase here', TEST_SCRYPT);
    // The change lands right after the login read the old hash, before it creates the session.
    const pool = new Proxy(db.pool, {
      get(target, property) {
        if (property !== 'query') {
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (text: string, values: unknown[]) => {
          const result = await target.query(text, values);
          if (text.includes('password_hash FROM users')) await updateEmployee(target, user.id, { passwordHash: newHash });
          return result;
        };
      },
    });
    const server = await serve({}, { pool });
    await expectError(await login(server.url, { email: 'ana@example.com', password: STRONG_PASSWORD }), 401, 'INVALID_CREDENTIALS');
    assert.equal((await db.pool.query('SELECT 1 FROM sessions')).rowCount, 0);
  });
});

describe('login rate limits', () => {
  const limited = { rateLimit: { loginMax: 2 } as Config['rateLimit'] };

  test('failed logins from one IP are limited; successful ones do not count', async () => {
    const server = await serve(limited);
    await insertUser(db.pool, { email: 'ana@example.com' });
    for (let i = 0; i < 3; i++) await signIn(server.url, 'ana@example.com');
    const wrong = { email: 'ana@example.com', password: 'wrong password entirely' };
    assert.equal((await login(server.url, wrong)).status, 401);
    assert.equal((await login(server.url, { ...wrong, email: 'other@example.com' })).status, 401);
    const blocked = await login(server.url, { email: 'ana@example.com', password: STRONG_PASSWORD });
    assert.equal(blocked.status, 429);
    assert.match(blocked.headers.get('ratelimit-policy') ?? '', /"login-ip"; q=2/);
    await expectError(blocked, 429, 'RATE_LIMITED');
  });

  test('failed logins against one account are limited across IPs', async () => {
    const server = await serve({ trustProxy: true, rateLimit: { loginAccountMax: 2 } as Config['rateLimit'] });
    await insertUser(db.pool, { email: 'ana@example.com' });
    const wrong = { email: 'ana@example.com', password: 'wrong password entirely' };
    assert.equal((await login(server.url, wrong, { 'X-Forwarded-For': '203.0.113.1' })).status, 401);
    assert.equal((await login(server.url, wrong, { 'X-Forwarded-For': '203.0.113.2' })).status, 401);
    const blocked = await login(server.url, wrong, { 'X-Forwarded-For': '203.0.113.3' });
    assert.equal(blocked.status, 429);
    assert.match(blocked.headers.get('ratelimit-policy') ?? '', /"login-account"; q=2/);
    await blocked.body?.cancel();
    // Another account from a fresh IP is unaffected, and emails are never stored in clear.
    assert.equal((await login(server.url, { ...wrong, email: 'bob@example.com' }, { 'X-Forwarded-For': '203.0.113.4' })).status, 401);
    const { rows } = await db.pool.query<{ key: string }>('SELECT key FROM rate_limits');
    assert.doesNotMatch(JSON.stringify(rows), /example\.com/);
  });

  test('the owner of an account signs in from another IP after the limit of one IP is reached', async () => {
    const server = await serve({ trustProxy: true, rateLimit: { loginMax: 2, loginAccountMax: 5 } as Config['rateLimit'] });
    await insertUser(db.pool, { email: 'ana@example.com' });
    const wrong = { email: 'ana@example.com', password: 'wrong password entirely' };
    const first = { 'X-Forwarded-For': '203.0.113.1' };
    assert.equal((await login(server.url, wrong, first)).status, 401);
    assert.equal((await login(server.url, wrong, first)).status, 401);
    assert.equal((await login(server.url, wrong, first)).status, 429);
    const owner = await login(server.url, { email: 'ana@example.com', password: STRONG_PASSWORD }, { 'X-Forwarded-For': '203.0.113.2' });
    assert.equal(owner.status, 200);
    await owner.body?.cancel();
  });
});

describe('sessions', () => {
  test('GET /api/auth/session returns the signed-in user, never cached', async () => {
    const server = await serve();
    const user = await insertUser(db.pool, { email: 'ana@example.com', role: 'admin' });
    const cookie = await signIn(server.url, 'ana@example.com');
    const response = await fetch(`${server.url}/api/auth/session`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { user });
  });

  for (const [label, cookie] of [
    ['no cookie', undefined],
    ['a malformed token', 'sid=not-a-token'],
    ['an unknown token', `sid=${'A'.repeat(43)}`],
    ['the production cookie name in development', `__Host-sid=${'A'.repeat(43)}`],
  ] as const) {
    test(`reports no user (200, user null) with ${label}`, async () => {
      const server = await serve();
      const response = await fetch(`${server.url}/api/auth/session`, { headers: cookie === undefined ? {} : { Cookie: cookie } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { user: null });
    });
  }

  test('an expired session is rejected', async () => {
    const server = await serve();
    await insertUser(db.pool, { email: 'ana@example.com' });
    const cookie = await signIn(server.url, 'ana@example.com');
    await db.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second'`);
    assert.equal(await sessionUser(server.url, cookie), null);
    await expectError(await fetch(`${server.url}/api/categories`, { headers: { Cookie: cookie } }), 401, 'UNAUTHENTICATED');
  });

  test('the session expires after SESSION_TTL_HOURS', async () => {
    const server = await serve({ sessionTtlMs: 2 * 3_600_000 });
    await insertUser(db.pool, { email: 'ana@example.com' });
    await signIn(server.url, 'ana@example.com');
    const { rows } = await db.pool.query<{ seconds: number }>(
      'SELECT extract(epoch FROM expires_at - created_at)::int AS seconds FROM sessions',
    );
    assert.equal(rows[0]?.seconds, 7200);
  });

  test('deleting the user ends their sessions', async () => {
    const server = await serve();
    const user = await insertUser(db.pool, { email: 'ana@example.com' });
    const cookie = await signIn(server.url, 'ana@example.com');
    await db.pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    assert.equal(await sessionUser(server.url, cookie), null);
  });

  test('logins clean up expired sessions in the background', async () => {
    const server = await serve({}, { logger: createCaptureLogger().logger, random: () => 0 });
    const user = await insertUser(db.pool, { email: 'ana@example.com' });
    await db.pool.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (decode(repeat('ab', 32), 'hex'), $1, now() - interval '1 hour')`,
      [user.id],
    );
    await signIn(server.url, 'ana@example.com');
    await waitUntil(async () => (await db.pool.query('SELECT 1 FROM sessions WHERE expires_at <= now()')).rowCount === 0);
  });
});

describe('POST /api/auth/logout', () => {
  test('deletes the session and clears the cookie', async () => {
    const server = await serve();
    await insertUser(db.pool, { email: 'ana@example.com' });
    const cookie = await signIn(server.url, 'ana@example.com');
    const response = await fetch(`${server.url}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(response.status, 204);
    assert.match(response.headers.get('set-cookie') ?? '', /^sid=; Max-Age=0; Path=\/; HttpOnly; SameSite=Strict$/);
    assert.equal(await sessionUser(server.url, cookie), null);
    assert.equal((await db.pool.query('SELECT 1 FROM sessions')).rowCount, 0);
  });

  test('is idempotent: without a session it answers 204 and leaves the cookies alone', async () => {
    const server = await serve();
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${server.url}/api/auth/logout`, { method: 'POST' });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('set-cookie'), null);
    }
  });

  test('other methods answer 405', async () => {
    const server = await serve();
    const response = await fetch(`${server.url}/api/auth/logout`);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    await response.body?.cancel();
  });
});
