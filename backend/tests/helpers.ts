import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type pg from 'pg';
import { createApp, type AppDependencies } from '../src/app.js';
import type { Config } from '../src/config.js';
import { startLocalDatabase } from '../src/db/local.js';
import { createPool } from '../src/db/pool.js';
import { ensureSchema, TABLES } from '../src/db/schema.js';
import { hashPassword, type ScryptParams } from '../src/lib/password.js';
import type { BreachCheck } from '../src/lib/password-policy.js';
import { silentLogger, type LogFields, type Logger } from '../src/logger.js';
import { createCategory } from '../src/models/category-model.js';
import { createUser } from '../src/models/user-model.js';
import type { Role, User } from '../src/schemas/user-schemas.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    isProduction: false,
    port: 0,
    databaseUrl: undefined,
    pgliteDataDir: undefined,
    corsOrigins: ['http://localhost:5173'],
    trustProxy: false,
    sessionTtlMs: 12 * 3_600_000,
    // Unroutable: a test that forgets to inject a breach check never reaches the real API
    // (the check answers "unavailable" and fails open).
    pwnedPasswordsUrl: 'http://127.0.0.1:9',
    ...overrides,
    rateLimit: {
      windowMs: 60_000,
      readMax: 10_000,
      writeMax: 10_000,
      loginWindowMs: 900_000,
      loginMax: 10_000,
      loginAccountMax: 10_000,
      ...overrides.rateLimit,
    },
  };
}

export interface TestDatabase {
  pool: pg.Pool;
  connectionString: string;
  close(): Promise<void>;
}

/** An in-memory Postgres (PGlite over the wire protocol) with the schema applied. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const local = await startLocalDatabase();
  const pool = createPool(local.connectionString, 1, silentLogger);
  await ensureSchema(pool);
  return {
    pool,
    connectionString: local.connectionString,
    close: async () => {
      await pool.end();
      await local.close();
    },
  };
}

export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

export interface LogEntry {
  level: 'info' | 'error';
  event: string;
  fields: LogFields;
}

/** A logger that records entries, so tests can assert what gets logged. */
export function createCaptureLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    logger: {
      info: (event, fields = {}) => entries.push({ level: 'info', event, fields }),
      error: (event, fields = {}) => entries.push({ level: 'error', event, fields }),
    },
  };
}

export interface TestServer {
  url: string;
  server: Server;
  close(): Promise<void>;
}

/** Listens on port 0; close() drops keep-alive connections left by fetch. */
export function startTestServer(app: Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        server,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}

/** Wraps a pool to count the queries it runs. */
export function countingPool(pool: pg.Pool): { pool: pg.Pool; count: () => number } {
  let queries = 0;
  const proxy = new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'query') {
        return (...args: unknown[]) => {
          queries += 1;
          return (target.query as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { pool: proxy, count: () => queries };
}

/** A pool stand-in whose every query fails with `error`. */
export function failingPool(error: Error): pg.Pool {
  const fail = () => Promise.reject(error);
  return { query: fail, connect: fail, end: async () => {}, on: () => {} } as unknown as pg.Pool;
}

/** Polls `check` until it returns true, so tests wait for conditions instead of fixed delays. */
export async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Cheap scrypt cost for tests; production uses PRODUCTION_SCRYPT (N = 2^17). */
export const TEST_SCRYPT: ScryptParams = { N: 2 ** 10, r: 8, p: 1, keyLength: 64 };

/** A fake Have I Been Pwned check: the given passwords count as breached; it records every call. */
export function fakeBreachCheck(breached: Iterable<string> = []): BreachCheck & { calls: string[] } {
  const set = new Set(breached);
  const calls: string[] = [];
  return Object.assign(
    async (password: string) => {
      calls.push(password);
      return set.has(password) ? ('breached' as const) : ('not_found' as const);
    },
    { calls },
  );
}

/** createApp with test defaults: cheap hashing, a fake breach check and a silent logger. */
export function createTestApp(deps: Partial<AppDependencies> & Pick<AppDependencies, 'pool'>): Express {
  return createApp({
    config: testConfig(),
    logger: silentLogger,
    scrypt: TEST_SCRYPT,
    breachCheck: fakeBreachCheck(),
    ...deps,
  });
}

export const STRONG_PASSWORD = 'correct horse battery staple';
/** Long enough and not on the offline list; fakes treat it as breached. */
export const BREACHED_PASSWORD = 'this one was in a breach';

/** Inserts a user directly through the model (with the cheap test hash). */
export async function insertUser(
  pool: pg.Pool,
  overrides: Partial<{ id: string; fullName: string; email: string; password: string; role: Role }> = {},
): Promise<User> {
  const password = overrides.password ?? STRONG_PASSWORD;
  return createUser(pool, {
    id: overrides.id ?? crypto.randomUUID(),
    fullName: overrides.fullName ?? 'Test User',
    email: overrides.email ?? `user-${crypto.randomUUID().slice(0, 8)}@example.com`,
    passwordHash: await hashPassword(password, TEST_SCRYPT),
    role: overrides.role ?? 'employee',
  });
}

/** The user GET /api/auth/session reports for this cookie (null: no valid session); always a 200. */
export async function sessionUser(url: string, cookie?: string): Promise<User | null> {
  const response = await fetch(`${url}/api/auth/session`, { headers: cookie === undefined ? {} : { Cookie: cookie } });
  assert.equal(response.status, 200);
  return ((await response.json()) as { user: User | null }).user;
}

/** Signs in through the API and returns the session cookie ("name=value") to send back. */
export async function signIn(url: string, email: string, password = STRONG_PASSWORD): Promise<string> {
  const response = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200) throw new Error(`Sign-in failed with ${response.status}: ${await response.text()}`);
  await response.body?.cancel();
  return sessionCookieOf(response);
}

/** The "name=value" part of the response's Set-Cookie header, ready to send back. */
export function sessionCookieOf(response: Response): string {
  const cookie = response.headers.get('set-cookie');
  if (cookie === null) throw new Error('The response set no cookie');
  return cookie.split(';')[0]!;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details: { path?: string; message: string }[];
}

/** Asserts the single JSON error format (status, code, content type, no-store) and returns the error. */
export async function expectError(response: Response, status: number, code: string): Promise<ApiErrorBody> {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { error } = (await response.json()) as { error: ApiErrorBody };
  assert.equal(error.code, code);
  assert.equal(typeof error.message, 'string');
  assert.ok(Array.isArray(error.details));
  return error;
}

export interface FakePwnedPasswords {
  url: string;
  /** Every request received, in order. */
  requests: IncomingMessage[];
  /** Overrides the default answer (status, body and an optional delay) for the next requests. */
  respond?: (prefix: string) => { status: number; body: string; delayMs?: number };
  close(): Promise<void>;
}

/**
 * A local stand-in for the Have I Been Pwned range API. By default it answers
 * like the real one: the hash suffixes for the prefix, here only those of the
 * given breached passwords (count 7).
 */
export async function startFakePwnedPasswords(breached: Iterable<string> = []): Promise<FakePwnedPasswords> {
  const hashes = [...breached].map((password) => createHash('sha1').update(password).digest('hex').toUpperCase());
  const fake: FakePwnedPasswords = {
    url: '',
    requests: [],
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const server = createServer((req, res) => {
    fake.requests.push(req);
    const prefix = req.url?.split('/').at(-1) ?? '';
    const answer = fake.respond?.(prefix) ?? {
      status: 200,
      body: hashes
        .filter((hash) => hash.startsWith(prefix))
        .map((hash) => `${hash.slice(5)}:7\r\n`)
        .join(''),
    };
    setTimeout(() => {
      res.writeHead(answer.status, { 'Content-Type': 'text/plain' });
      res.end(answer.body);
    }, answer.delayMs ?? 0);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

/** Inserts a category through the model, like insertUser. */
export async function insertCategory(pool: pg.Pool, name: string) {
  return (await createCategory(pool, { id: crypto.randomUUID(), name })).item;
}

/** Inserts a product directly, without recording movements (test setup only). */
export async function insertProduct(
  pool: pg.Pool,
  categoryId: string,
  overrides: Partial<{ brand: string; name: string; description: string; quantity: number; price: string }> = {},
) {
  const values = { brand: 'Acme', name: 'Whole milk 1 L', description: '', quantity: 20, price: '1250.00', ...overrides };
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO products (category_id, brand, name, description, quantity, price)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [categoryId, values.brand, values.name, values.description, values.quantity, values.price],
  );
  return rows[0]!.id;
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';

/** fetch bound to a test server: optional session cookie and JSON body. */
export function apiCaller(baseUrl: string) {
  return (method: HttpMethod, path: string, options: { cookie?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    if (options.cookie !== undefined) headers.Cookie = options.cookie;
    if (options.body !== undefined) Object.assign(headers, JSON_HEADERS);
    return fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  };
}

/** Follows `Link: rel="next"` from `path` to the last page and returns every id in order. */
export async function walkPages(
  call: ReturnType<typeof apiCaller>,
  path: string,
  cookie: string,
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let pages = 0;
  let next: string | null = path;
  while (next !== null) {
    const response = await call('GET', next, { cookie });
    assert.equal(response.status, 200);
    ids.push(...((await response.json()) as { id: string }[]).map((item) => item.id));
    pages += 1;
    next = /<([^>]+)>; rel="next"/.exec(response.headers.get('link') ?? '')?.[1] ?? null;
  }
  return { ids, pages };
}

/**
 * Gives the rows of `table` fixed created_at values: the first `distinct` (in id
 * order) one second apart, and the rest tied on one instant. Ordering tests then
 * always exercise both sort keys, whatever the clock resolution.
 */
export async function spreadCreatedAt(
  pool: pg.Pool,
  table: 'users' | 'categories' | 'products' | 'stock_movements',
  distinct: number,
) {
  await pool.query(
    `UPDATE ${table} AS t SET created_at = CASE
       WHEN o.n <= $1 THEN timestamptz '2026-01-01T00:00:00Z' + o.n * interval '1 second'
       ELSE timestamptz '2026-01-01T00:00:00.123456Z'
     END
     FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM ${table}) o
     WHERE o.id = t.id`,
    [distinct],
  );
}
