// What must hold when requests really overlap, checked through the API. Two targets
// run these scenarios: PGlite inside `npm test`, where the single session serializes
// everything and only the outcomes are proved, and a real Postgres in
// `npm run test:concurrency`, where the row locks and the pooler do the work.
//
// A 503 is always accepted: a database too slow for its limits may refuse a write.
// The checks that follow prove such a write left nothing behind. A 500 is never accepted.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createApp } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { createPool } from '../../src/db/pool.js';
import { ensureSchema, TABLES } from '../../src/db/schema.js';
import { isDatabaseUnavailable } from '../../src/middlewares/errors.js';
import {
  apiCaller,
  createCaptureLogger,
  fakeBreachCheck,
  insertCategory,
  insertProduct,
  insertUser,
  resetDatabase,
  signIn,
  startTestServer,
  STRONG_PASSWORD,
  testConfig,
  TEST_SCRYPT,
  type HttpMethod,
  type TestServer,
} from '../helpers.js';

export interface ConcurrencyTarget {
  /** App instances, each with its own pool, like several Vercel Function instances. */
  instances: number;
  poolSize: number;
  /** Whether the database takes extra connections and runs them at the same time. */
  realSessions: boolean;
  /** Each round of a race starts its second request this much later than the last round did. */
  raceStepMs: number;
  open(): Promise<{ connectionString: string; close(): Promise<void> }>;
}

interface Result {
  status: number;
  body: unknown;
  cookie: string | undefined;
}
type Options = { cookie?: string; body?: unknown };
type Caller = (method: HttpMethod, path: string, options?: Options) => Promise<Result>;

const OVERLAPPING_REQUESTS = 12;
const ROUNDS = 5;
const NEW_PASSWORD = 'a completely different passphrase';

const id = () => crypto.randomUUID();
const times = <T>(count: number, make: (index: number) => T): T[] => Array.from({ length: count }, (_, i) => make(i));
const count = (results: Result[], status: number) => results.filter((result) => result.status === status).length;

export function defineConcurrencyScenarios(target: ConcurrencyTarget): void {
  describe('overlapping requests', () => {
    const { logger, entries } = createCaptureLogger();
    let connectionString: string;
    let closeTarget: () => Promise<void>;
    let pools: pg.Pool[];
    let main: pg.Pool;
    let servers: TestServer[] = [];
    let api: Caller;
    let adminCookie: string;
    let employeeCookie: string;

    async function startServers(config: Partial<Config> = {}): Promise<TestServer[]> {
      return Promise.all(
        pools.map((pool) =>
          startTestServer(
            createApp({ pool, config: testConfig(config), logger, scrypt: TEST_SCRYPT, breachCheck: fakeBreachCheck() }),
          ),
        ),
      );
    }

    /** Sends each request to the next instance, in turn. */
    function callerFor(targets: TestServer[]): Caller {
      let next = 0;
      return async (method, path, options = {}) => {
        const response = await apiCaller(targets[next++ % targets.length]!.url)(method, path, options);
        const text = await response.text();
        return {
          status: response.status,
          body: text === '' ? null : JSON.parse(text),
          cookie: response.headers.get('set-cookie')?.split(';')[0],
        };
      };
    }

    /** Fails on any status outside `allowed` (and 503), naming the server errors behind a 500. */
    function expectStatuses(t: TestContext, label: string, results: Result[], allowed: number[]): void {
      const tally: Record<string, number> = {};
      for (const { status } of results) tally[status] = (tally[status] ?? 0) + 1;
      t.diagnostic(`${label}: ${JSON.stringify(tally)}`);
      const failures = entries
        .filter((entry) => entry.event === 'request_failed' && entry.fields.status === 500)
        .map((entry) => {
          const error = entry.fields.error as { code?: string; message?: string };
          return `${String(entry.fields.path)}: ${error.code ?? 'no code'} ${error.message ?? ''}`;
        });
      for (const { status } of results) {
        assert.ok([...allowed, 503].includes(status), `${label}: unexpected ${status}. ${failures.join('; ')}`);
      }
    }

    const quantityOf = async (productId: string) => {
      const { rows } = await main.query<{ quantity: number }>('SELECT quantity FROM products WHERE id = $1', [productId]);
      return rows[0]?.quantity;
    };
    const recordedDelta = async (column: 'product_id' | 'product_name', value: string) => {
      const { rows } = await main.query<{ total: number }>(
        `SELECT coalesce(sum(delta), 0)::int AS total FROM stock_movement_items WHERE ${column} = $1`,
        [value],
      );
      return rows[0]!.total;
    };
    const sale = (productId: string, quantity = 1, movementId = id()) => ({
      id: movementId,
      type: 'sale',
      items: [{ productId, quantity }],
    });
    /** Starts `request` later in each round, so a race is seen with both orders. */
    const staggered = async <T>(round: number, request: () => Promise<T>): Promise<T> => {
      await delay(round * target.raceStepMs);
      return request();
    };
    /** Like vercel.ts: a transient refusal is retried, and the schema must end up applied. */
    const applySchema = async (t: TestContext, pool: pg.Pool): Promise<void> => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await ensureSchema(pool);
          t.diagnostic(`schema applied on attempt ${attempt}`);
          return;
        } catch (error) {
          assert.ok(isDatabaseUnavailable(error), String(error));
        }
      }
      assert.fail('the schema could not be applied');
    };
    const schemaHash = async () => {
      const { rows } = await main.query<{ hash: string }>('SELECT hash FROM schema_version');
      return rows.map((row) => row.hash);
    };

    before(async () => {
      const opened = await target.open();
      connectionString = opened.connectionString;
      closeTarget = opened.close;
      pools = times(target.instances, () => createPool(connectionString, target.poolSize, logger));
      main = pools[0]!;
      await ensureSchema(main);
      servers = await startServers();
      api = callerFor(servers);
    });

    after(async () => {
      await Promise.all(servers.map((server) => server.close()));
      await Promise.all(pools.map((pool) => pool.end()));
      await closeTarget();
    });

    beforeEach(async () => {
      entries.length = 0;
      await resetDatabase(main);
      const admin = await insertUser(main, { role: 'admin' });
      const employee = await insertUser(main);
      adminCookie = await signIn(servers[0]!.url, admin.email);
      employeeCookie = await signIn(servers[0]!.url, employee.email);
    });

    test('instances starting together on an empty database create the schema once', async (t) => {
      await main.query(`DROP TABLE IF EXISTS ${TABLES.join(', ')}, schema_version CASCADE`);
      const racing = target.realSessions ? times(4, () => createPool(connectionString, 1, logger)) : [main, main, main];
      try {
        await Promise.all(racing.map((pool) => applySchema(t, pool)));
      } finally {
        if (target.realSessions) await Promise.all(racing.map((pool) => pool.end()));
      }
      assert.equal((await schemaHash()).length, 1);
    });

    test('a schema change applied during writes breaks neither', async (t) => {
      const category = await insertCategory(main, 'Dairy');
      const product = await insertProduct(main, category.id, { quantity: 100 });
      await main.query(`UPDATE schema_version SET hash = 'an older schema'`);

      const writes = times(OVERLAPPING_REQUESTS, () =>
        api('POST', '/api/stock-movements', { cookie: employeeCookie, body: sale(product) }),
      );
      const schemas = times(3, () => applySchema(t, main));
      const results = await Promise.all(writes);
      await Promise.all(schemas);

      expectStatuses(t, 'sales', results, [201]);
      assert.equal(await quantityOf(product), 100 - count(results, 201));
      assert.equal(await recordedDelta('product_id', product), -count(results, 201));
      assert.notDeepEqual(await schemaHash(), ['an older schema']);
    });

    test('sales of the last units never oversell', async (t) => {
      const category = await insertCategory(main, 'Dairy');
      const product = await insertProduct(main, category.id, { quantity: 6 });
      const results = await Promise.all(
        times(OVERLAPPING_REQUESTS, () => api('POST', '/api/stock-movements', { cookie: employeeCookie, body: sale(product) })),
      );
      expectStatuses(t, 'sales', results, [201, 409]);
      const sold = count(results, 201);
      assert.ok(sold <= 6, `${sold} units sold out of 6`);
      if (count(results, 503) === 0) assert.equal(sold, 6);
      assert.equal(await quantityOf(product), 6 - sold);
      assert.equal(await recordedDelta('product_id', product), -sold);
    });

    test('forms sharing products in any order all apply, without deadlocks', async (t) => {
      const category = await insertCategory(main, 'Dairy');
      const products = await Promise.all(
        times(5, (i) => insertProduct(main, category.id, { name: `Product ${i}`, quantity: 1000 })),
      );
      const forms = times(OVERLAPPING_REQUESTS, (form) => ({
        id: id(),
        type: 'sale',
        // Each form walks the products in a different order, from a different start.
        items: times(3, (line) => ({
          productId: products[(form + (form % 2 === 0 ? line : -line) + products.length) % products.length]!,
          quantity: line + 1,
        })),
      }));
      const results = await Promise.all(
        forms.map((body) => api('POST', '/api/stock-movements', { cookie: employeeCookie, body })),
      );
      expectStatuses(t, 'forms', results, [201]);

      for (const product of products) {
        const sold = forms
          .filter((_, index) => results[index]!.status === 201)
          .flatMap((form) => form.items)
          .filter((item) => item.productId === product)
          .reduce((total, item) => total + item.quantity, 0);
        assert.equal(await quantityOf(product), 1000 - sold);
        assert.equal(await recordedDelta('product_id', product), -sold);
      }
    });

    test('the same movement sent many times applies once', async (t) => {
      const category = await insertCategory(main, 'Dairy');
      const product = await insertProduct(main, category.id, { quantity: 50 });
      const body = sale(product, 2);
      const results = await Promise.all(
        times(OVERLAPPING_REQUESTS, () => api('POST', '/api/stock-movements', { cookie: employeeCookie, body })),
      );
      expectStatuses(t, 'retries', results, [200, 201]);
      assert.ok(count(results, 201) <= 1);
      assert.equal(await quantityOf(product), 48);
      assert.equal(await recordedDelta('product_id', product), -2);
    });

    test('the same product sent many times is created once, with one adjustment', async (t) => {
      const category = await insertCategory(main, 'Dairy');
      const body = { id: id(), categoryId: category.id, brand: 'Acme', name: 'Whole milk', quantity: 7, price: '100.00' };
      const results = await Promise.all(
        times(OVERLAPPING_REQUESTS, () => api('POST', '/api/products', { cookie: adminCookie, body })),
      );
      expectStatuses(t, 'retries', results, [200, 201]);
      assert.ok(count(results, 201) <= 1);
      assert.equal(await quantityOf(body.id), 7);
      assert.equal(await recordedDelta('product_id', body.id), 7);
    });

    test('edits based on the same version: one wins, the others conflict', async (t) => {
      const category = await insertCategory(main, 'Dairy');
      const product = await insertProduct(main, category.id);
      const results = await Promise.all(
        times(OVERLAPPING_REQUESTS, (i) =>
          api('PATCH', `/api/products/${product}`, { cookie: adminCookie, body: { version: 1, name: `Name ${i}` } }),
        ),
      );
      expectStatuses(t, 'edits', results, [200, 409]);
      assert.ok(count(results, 200) <= 1);
      const { rows } = await main.query<{ version: number }>('SELECT version FROM products WHERE id = $1', [product]);
      assert.equal(rows[0]!.version, 1 + count(results, 200));
    });

    test('a category name and an email are taken once', async (t) => {
      const categories = await Promise.all(
        times(OVERLAPPING_REQUESTS, (i) =>
          api('POST', '/api/categories', { cookie: adminCookie, body: { id: id(), name: i % 2 === 0 ? 'Frozen' : 'FROZEN' } }),
        ),
      );
      expectStatuses(t, 'category names', categories, [201, 409]);
      assert.ok(count(categories, 201) <= 1);

      const employees = await Promise.all(
        times(OVERLAPPING_REQUESTS, () =>
          api('POST', '/api/employees', {
            cookie: adminCookie,
            body: { id: id(), fullName: 'Same Person', email: 'same.person@example.com', password: STRONG_PASSWORD },
          }),
        ),
      );
      expectStatuses(t, 'emails', employees, [201, 409]);
      assert.ok(count(employees, 201) <= 1);
    });

    test('a sign-in with the previous password never outlives a password change', async (t) => {
      for (let round = 0; round < ROUNDS; round++) {
        const employee = await insertUser(main);
        const login = () =>
          api('POST', '/api/auth/login', { body: { email: employee.email, password: STRONG_PASSWORD } });
        const [first, second, change, third, fourth] = await Promise.all([
          login(),
          login(),
          api('PATCH', `/api/employees/${employee.id}`, { cookie: adminCookie, body: { password: NEW_PASSWORD } }),
          login(),
          login(),
        ]);
        const logins = [first, second, third, fourth];
        expectStatuses(t, `round ${round} logins`, logins, [200, 401]);
        expectStatuses(t, `round ${round} change`, [change], [200]);
        if (change.status !== 200) continue;

        for (const { cookie } of logins.filter((result) => result.status === 200)) {
          const session = await api('GET', '/api/auth/session', { cookie: cookie! });
          assert.deepEqual(session.body, { user: null });
        }
      }
    });

    test('deleting a category and adding a product to it: never both', async (t) => {
      for (let round = 0; round < ROUNDS; round++) {
        const category = await insertCategory(main, `Category ${round}`);
        const [removed, created] = await Promise.all([
          staggered(round, () => api('DELETE', `/api/categories/${category.id}`, { cookie: adminCookie })),
          api('POST', '/api/products', {
            cookie: adminCookie,
            body: { id: id(), categoryId: category.id, brand: 'Acme', name: 'Milk', quantity: 0, price: '1.00' },
          }),
        ]);
        expectStatuses(t, `round ${round} delete`, [removed], [204, 409]);
        expectStatuses(t, `round ${round} create`, [created], [201, 400]);
        assert.ok(!(removed.status === 204 && created.status === 201), 'the product lost its category');
      }
    });

    test('deleting a product during a sale keeps the history exact', async (t) => {
      const category = await insertCategory(main, 'Dairy');
      for (let round = 0; round < ROUNDS; round++) {
        const name = `Product ${round}`;
        const product = await insertProduct(main, category.id, { name, quantity: 10 });
        const [sold, removed] = await Promise.all([
          api('POST', '/api/stock-movements', { cookie: employeeCookie, body: sale(product, 3) }),
          staggered(round, () => api('DELETE', `/api/products/${product}`, { cookie: adminCookie })),
        ]);
        expectStatuses(t, `round ${round} sale`, [sold], [201, 400]);
        expectStatuses(t, `round ${round} delete`, [removed], [204]);
        if (removed.status !== 204) continue;
        assert.equal(await quantityOf(product), undefined);
        assert.equal(await recordedDelta('product_name', name), -10);
      }
    });

    test('deleting an employee during their sale leaves consistent stock', async (t) => {
      const category = await insertCategory(main, 'Dairy');
      const product = await insertProduct(main, category.id, { quantity: 100 });
      for (let round = 0; round < ROUNDS; round++) {
        const employee = await insertUser(main);
        const cookie = await signIn(servers[0]!.url, employee.email);
        const [sold, removed] = await Promise.all([
          api('POST', '/api/stock-movements', { cookie, body: sale(product) }),
          staggered(round, () => api('DELETE', `/api/employees/${employee.id}`, { cookie: adminCookie })),
        ]);
        expectStatuses(t, `round ${round} sale`, [sold], [201, 401]);
        expectStatuses(t, `round ${round} delete`, [removed], [204]);
      }
      assert.equal(await quantityOf(product), 100 + (await recordedDelta('product_id', product)));
    });

    test('the write limit holds across instances', async (t) => {
      const limited = await startServers({ rateLimit: { writeMax: 5 } as Config['rateLimit'] });
      try {
        await main.query('TRUNCATE rate_limits');
        const call = callerFor(limited);
        const results = await Promise.all(times(OVERLAPPING_REQUESTS, () => call('POST', '/api/auth/logout')));
        expectStatuses(t, 'writes', results, [204, 429]);
        assert.ok(count(results, 204) <= 5, `${count(results, 204)} writes passed a limit of 5`);
        if (count(results, 503) === 0) assert.equal(count(results, 204), 5);
      } finally {
        await Promise.all(limited.map((server) => server.close()));
      }
    });

    test('the failed sign-in limit holds across instances', async (t) => {
      const limited = await startServers({ rateLimit: { loginMax: 5 } as Config['rateLimit'] });
      try {
        await main.query('TRUNCATE rate_limits');
        const call = callerFor(limited);
        const results = await Promise.all(
          times(OVERLAPPING_REQUESTS, () =>
            call('POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: 'not the password' } }),
          ),
        );
        expectStatuses(t, 'sign-ins', results, [401, 429]);
        assert.ok(count(results, 401) <= 5, `${count(results, 401)} attempts passed a limit of 5`);
        if (count(results, 503) === 0) assert.equal(count(results, 401), 5);
      } finally {
        await Promise.all(limited.map((server) => server.close()));
      }
    });

    test(
      'a write blocked past the transaction limit answers 503 and changes nothing',
      { skip: !target.realSessions && 'Needs a second session that holds a row lock.' },
      async (t) => {
        const category = await insertCategory(main, 'Dairy');
        const product = await insertProduct(main, category.id, { quantity: 10 });
        const body = sale(product);
        const holder = new pg.Client({ connectionString });
        await holder.connect();
        try {
          await holder.query('BEGIN');
          await holder.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [product]);
          const blocked = await api('POST', '/api/stock-movements', { cookie: employeeCookie, body });
          t.diagnostic(`blocked sale: ${blocked.status}`);
          assert.equal(blocked.status, 503);
          await holder.query('COMMIT');
        } finally {
          await holder.end();
        }
        assert.equal(await quantityOf(product), 10);

        // Nothing of the first attempt remains, so the same id can still apply.
        const retried = await api('POST', '/api/stock-movements', { cookie: employeeCookie, body });
        assert.equal(retried.status, 201);
        assert.equal(await quantityOf(product), 9);
      },
    );
  });
}
