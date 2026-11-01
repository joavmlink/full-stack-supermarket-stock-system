import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Stats } from '../src/schemas/stats-schemas.js';
import type { User } from '../src/schemas/user-schemas.js';
import {
  apiCaller,
  createTestApp,
  expectError,
  insertCategory,
  insertProduct,
  insertUser,
  resetDatabase,
  signIn,
  startTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
} from './helpers.js';

let db: TestDatabase;
let server: TestServer;
let call: ReturnType<typeof apiCaller>;
let employee: User;
let adminCookie: string;
let employeeCookie: string;

before(async () => {
  db = await startTestDatabase();
  server = await startTestServer(createTestApp({ pool: db.pool }));
  call = apiCaller(server.url);
});

after(async () => {
  await server.close();
  await db.close();
});

beforeEach(async () => {
  await resetDatabase(db.pool);
  await insertUser(db.pool, { email: 'admin@example.com', role: 'admin' });
  employee = await insertUser(db.pool, { email: 'employee@example.com' });
  await insertUser(db.pool, { email: 'other@example.com' });
  adminCookie = await signIn(server.url, 'admin@example.com');
  employeeCookie = await signIn(server.url, 'employee@example.com');
});

async function stats(cookie: string): Promise<Stats> {
  const response = await call('GET', '/api/stats', { cookie });
  assert.equal(response.status, 200);
  return (await response.json()) as Stats;
}

async function insertMovement(type: string, userId: string | null) {
  await db.pool.query(
    `INSERT INTO stock_movements (id, type, user_id, user_full_name) VALUES (gen_random_uuid(), $1, $2, 'Someone')`,
    [type, userId],
  );
}

describe('GET /api/stats', () => {
  test('answers zeros on an empty inventory', async () => {
    assert.deepEqual(await stats(adminCookie), {
      lowStockThreshold: 10,
      products: { total: 0, outOfStock: 0, lowStock: 0, totalUnits: 0, inventoryValue: '0.00' },
      categories: { total: 0 },
      movements: { sale: 0, restock: 0, adjustment: 0 },
      employees: { total: 2 },
    });
  });

  test('counts out of stock (0) and low stock (1 to 10) separately, at the boundaries', async () => {
    const dairy = await insertCategory(db.pool, 'Dairy');
    await insertCategory(db.pool, 'Bakery');
    for (const quantity of [0, 0, 1, 10, 11, 100]) await insertProduct(db.pool, dairy.id, { quantity, price: '1.00' });
    const { products, categories } = await stats(adminCookie);
    assert.equal(products.total, 6);
    assert.equal(products.outOfStock, 2);
    assert.equal(products.lowStock, 2);
    assert.equal(products.totalUnits, 122);
    assert.equal(categories.total, 2);
  });

  test('adds the inventory value with exact decimals', async () => {
    const dairy = await insertCategory(db.pool, 'Dairy');
    // 3 x 0.10 + 1 x 0.20 is 0.5 exactly in NUMERIC; floats would not give 0.50 reliably.
    await insertProduct(db.pool, dairy.id, { quantity: 3, price: '0.10' });
    await insertProduct(db.pool, dairy.id, { quantity: 1, price: '0.20' });
    await insertProduct(db.pool, dairy.id, { quantity: 1_000_000, price: '99999999.99' });
    const { products } = await stats(adminCookie);
    assert.equal(products.inventoryValue, '99999999990000.50');
  });

  test('admins see every movement and the employee count', async () => {
    await insertMovement('sale', employee.id);
    await insertMovement('sale', null);
    await insertMovement('restock', employee.id);
    await insertMovement('adjustment', null);
    const result = await stats(adminCookie);
    assert.deepEqual(result.movements, { sale: 2, restock: 1, adjustment: 1 });
    assert.deepEqual(result.employees, { total: 2 });
  });

  test('employees see only their own movements and no employee count', async () => {
    await insertMovement('sale', employee.id);
    await insertMovement('sale', null);
    await insertMovement('restock', employee.id);
    const result = await stats(employeeCookie);
    assert.deepEqual(result.movements, { sale: 1, restock: 1, adjustment: 0 });
    assert.equal('employees' in result, false);
  });

  test('requires a session', async () => {
    await expectError(await call('GET', '/api/stats'), 401, 'UNAUTHENTICATED');
  });
});
