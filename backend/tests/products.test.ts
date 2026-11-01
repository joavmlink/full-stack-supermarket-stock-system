import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Product } from '../src/schemas/product-schemas.js';
import type { User } from '../src/schemas/user-schemas.js';
import {
  apiCaller,
  countingPool,
  createTestApp,
  expectError,
  insertCategory,
  insertProduct,
  insertUser,
  resetDatabase,
  signIn,
  startTestDatabase,
  startTestServer,
  type HttpMethod,
  type TestDatabase,
  walkPages,
  type TestServer,
} from './helpers.js';

let db: TestDatabase;
let server: TestServer;
let call: ReturnType<typeof apiCaller>;
let admin: User;
let adminCookie: string;
let employeeCookie: string;
let dairy: { id: string; name: string };

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
  admin = await insertUser(db.pool, { email: 'admin@example.com', fullName: 'Admin Person', role: 'admin' });
  await insertUser(db.pool, { email: 'employee@example.com' });
  adminCookie = await signIn(server.url, 'admin@example.com');
  employeeCookie = await signIn(server.url, 'employee@example.com');
  dairy = await insertCategory(db.pool, 'Dairy');
});

const asAdmin = (method: HttpMethod, path: string, body?: unknown) => call(method, path, { cookie: adminCookie, body });

const newProduct = (overrides: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  categoryId: dairy.id,
  brand: 'La Serenísima',
  name: 'Whole milk 1 L',
  description: 'Pasteurized',
  quantity: 24,
  price: '1250.5',
  ...overrides,
});

async function movementsOf(productId: string) {
  const { rows } = await db.pool.query(
    `SELECT m.type, m.user_id, m.user_full_name, i.product_name, i.product_brand, i.unit_price, i.delta, i.quantity_after
     FROM stock_movements m JOIN stock_movement_items i ON i.movement_id = m.id
     WHERE i.product_id = $1 ORDER BY m.created_at`,
    [productId],
  );
  return rows;
}

async function create(overrides: Record<string, unknown> = {}): Promise<Product> {
  const response = await asAdmin('POST', '/api/products', newProduct(overrides));
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as Product;
}

describe('access control', () => {
  test('employees read products; only admins create, edit or delete them', async () => {
    const id = await insertProduct(db.pool, dairy.id);
    assert.equal((await call('GET', '/api/products', { cookie: employeeCookie })).status, 200);
    assert.equal((await call('GET', `/api/products/${id}`, { cookie: employeeCookie })).status, 200);
    const writes: [HttpMethod, string, unknown][] = [
      ['POST', '/api/products', newProduct()],
      ['PATCH', `/api/products/${id}`, { version: 1, name: 'X' }],
      ['DELETE', `/api/products/${id}`, undefined],
    ];
    for (const [method, path, body] of writes) {
      await expectError(await call(method, path, { cookie: employeeCookie, body }), 403, 'FORBIDDEN');
      await expectError(await call(method, path, { body }), 401, 'UNAUTHENTICATED');
    }
    await expectError(await call('GET', '/api/products'), 401, 'UNAUTHENTICATED');
  });
});

describe('POST /api/products', () => {
  test('creates a product with its category, a normalized price and version 1', async () => {
    const body = newProduct();
    const response = await asAdmin('POST', '/api/products', body);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('location'), `/api/products/${body.id}`);
    const product = (await response.json()) as Product;
    assert.deepEqual(
      { ...product, createdAt: undefined, updatedAt: undefined },
      {
        id: body.id,
        category: { id: dairy.id, name: 'Dairy' },
        brand: 'La Serenísima',
        name: 'Whole milk 1 L',
        description: 'Pasteurized',
        quantity: 24,
        price: '1250.50',
        version: 1,
        createdAt: undefined,
        updatedAt: undefined,
      },
    );
  });

  test('records the initial stock as an adjustment by the admin', async () => {
    const product = await create({ quantity: 24 });
    assert.deepEqual(await movementsOf(product.id), [
      {
        type: 'adjustment',
        user_id: admin.id,
        user_full_name: 'Admin Person',
        product_name: 'Whole milk 1 L',
        product_brand: 'La Serenísima',
        unit_price: '1250.50',
        delta: 24,
        quantity_after: 24,
      },
    ]);
  });

  test('a product created without stock records no movement; description defaults to empty', async () => {
    const { description: _description, ...body } = newProduct({ quantity: 0 });
    const response = await asAdmin('POST', '/api/products', body);
    const product = (await response.json()) as Product;
    assert.equal(product.description, '');
    assert.deepEqual(await movementsOf(product.id), []);
  });

  for (const [label, override, path] of [
    ['a numeric price (money must be a string)', { price: 1250.5 }, 'price'],
    ['a price with 3 decimals', { price: '1.234' }, 'price'],
    ['a price with 9 integer digits', { price: '123456789' }, 'price'],
    ['a negative price', { price: '-1' }, 'price'],
    ['a price with a comma', { price: '1250,50' }, 'price'],
    ['a negative quantity', { quantity: -1 }, 'quantity'],
    ['a quantity over 1,000,000', { quantity: 1_000_001 }, 'quantity'],
    ['a fractional quantity', { quantity: 1.5 }, 'quantity'],
    ['an empty brand', { brand: ' ' }, 'brand'],
    ['a name over 100 characters', { name: 'x'.repeat(101) }, 'name'],
    ['a description over 1000 characters', { description: 'x'.repeat(1001) }, 'description'],
    ['an invalid category id', { categoryId: 'dairy' }, 'categoryId'],
    ['an extra field', { sku: '123' }, ''],
  ] as const) {
    test(`rejects ${label} with 400`, async () => {
      const error = await expectError(await asAdmin('POST', '/api/products', newProduct(override)), 400, 'VALIDATION_ERROR');
      assert.ok(error.details.some((detail) => detail.path === path), JSON.stringify(error.details));
    });
  }

  test('an unknown category answers 400 on categoryId and creates nothing', async () => {
    const error = await expectError(
      await asAdmin('POST', '/api/products', newProduct({ categoryId: crypto.randomUUID() })),
      400,
      'VALIDATION_ERROR',
    );
    assert.deepEqual(error.details, [{ path: 'categoryId', message: 'does not match any category' }]);
    assert.equal((await db.pool.query('SELECT 1 FROM products')).rowCount, 0);
  });

  test('repeating the same create returns the stored product with 200 and records nothing twice', async () => {
    const body = newProduct({ price: '1250.5' });
    const first = await asAdmin('POST', '/api/products', body);
    assert.equal(first.status, 201);
    const created = await first.json();
    // The same price written another way is the same write.
    const replay = await asAdmin('POST', '/api/products', { ...body, price: '01250.50' });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('location'), `/api/products/${body.id}`);
    assert.deepEqual(await replay.json(), created);
    assert.equal((await movementsOf(body.id)).length, 1);
  });

  test('the same id with other values answers 409 ALREADY_EXISTS and records nothing', async () => {
    const body = newProduct();
    assert.equal((await asAdmin('POST', '/api/products', body)).status, 201);
    await expectError(await asAdmin('POST', '/api/products', { ...body, name: 'Other' }), 409, 'ALREADY_EXISTS');
    assert.equal((await movementsOf(body.id)).length, 1);
  });

  test('a replay after the stock moved answers 409, since the product no longer holds those values', async () => {
    const body = newProduct({ quantity: 24 });
    assert.equal((await asAdmin('POST', '/api/products', body)).status, 201);
    const sale = await asAdmin('POST', '/api/stock-movements', {
      id: crypto.randomUUID(),
      type: 'sale',
      items: [{ productId: body.id, quantity: 1 }],
    });
    assert.equal(sale.status, 201);
    await expectError(await asAdmin('POST', '/api/products', body), 409, 'ALREADY_EXISTS');
  });
});

describe('GET /api/products', () => {
  const walk = async (path: string) => (await walkPages(call, path, adminCookie)).ids;

  test('walks every page newest first, including created_at ties', async () => {
    for (let i = 0; i < 5; i++) await insertProduct(db.pool, dairy.id, { name: `P${i}` });
    await db.pool.query(`UPDATE products SET created_at = '2026-01-01T00:00:00.123456Z' WHERE name IN ('P1', 'P2', 'P3')`);
    const { rows } = await db.pool.query<{ id: string }>('SELECT id FROM products ORDER BY created_at DESC, id DESC');
    assert.deepEqual(await walk('/api/products?limit=2'), rows.map((row) => row.id));
  });

  test('searches name and brand ignoring case, with % and _ taken literally', async () => {
    const milk = await insertProduct(db.pool, dairy.id, { name: 'Whole MILK 1 L', brand: 'Acme' });
    const yogurt = await insertProduct(db.pool, dairy.id, { name: 'Yogurt', brand: 'Milkaut' });
    await insertProduct(db.pool, dairy.id, { name: 'Butter', brand: 'Acme' });
    const promo = await insertProduct(db.pool, dairy.id, { name: 'Cheese 50% off', brand: 'Acme' });
    await insertProduct(db.pool, dairy.id, { name: 'Cheese 500 g', brand: 'Acme' });
    assert.deepEqual((await walk('/api/products?q=milk')).sort(), [milk, yogurt].sort());
    assert.deepEqual(await walk(`/api/products?q=${encodeURIComponent('50%')}`), [promo]);
    assert.deepEqual(await walk('/api/products?q=_'), []);
  });

  test('text is NFC-normalized, so searches match whichever Unicode form was typed', async () => {
    const product = await create({ name: 'Café con leche', brand: 'Nestlé' });
    assert.equal(product.name, 'Café con leche');
    assert.equal(product.brand, 'Nestlé');
    assert.deepEqual(await walk(`/api/products?q=${encodeURIComponent('café')}`), [product.id]);
    assert.deepEqual(await walk(`/api/products?q=${encodeURIComponent('café')}`), [product.id]);
  });

  test('filters by category, and the next link keeps the filters', async () => {
    const bakery = await insertCategory(db.pool, 'Bakery');
    for (let i = 0; i < 3; i++) await insertProduct(db.pool, bakery.id, { name: `Bread ${i}` });
    await insertProduct(db.pool, dairy.id, { name: 'Bread milk' });
    const first = await asAdmin('GET', `/api/products?limit=2&q=bread&categoryId=${bakery.id}`);
    assert.match(first.headers.get('link') ?? '', new RegExp(`limit=2&q=bread&categoryId=${bakery.id}&before=`));
    await first.body?.cancel();
    const ids = await walk(`/api/products?limit=2&q=bread&categoryId=${bakery.id}`);
    assert.equal(ids.length, 3);
  });

  for (const query of ['limit=0', 'limit=101', 'q=', `q=${'x'.repeat(101)}`, 'q=a%00b', 'categoryId=dairy', 'sort=price', `before=${'0'.repeat(8)}`]) {
    test(`rejects ?${query} with 400`, async () => {
      await expectError(await asAdmin('GET', `/api/products?${query}`), 400, 'VALIDATION_ERROR');
    });
  }

  test('an unknown cursor answers 400', async () => {
    await expectError(await asAdmin('GET', `/api/products?before=${crypto.randomUUID()}`), 400, 'VALIDATION_ERROR');
  });
});

describe('GET /api/products/:id', () => {
  test('returns the product, 404 when unknown and 400 when invalid', async () => {
    const product = await create();
    assert.deepEqual(await (await asAdmin('GET', `/api/products/${product.id}`)).json(), product);
    await expectError(await asAdmin('GET', `/api/products/${crypto.randomUUID()}`), 404, 'PRODUCT_NOT_FOUND');
    await expectError(await asAdmin('GET', '/api/products/123'), 400, 'VALIDATION_ERROR');
  });
});

describe('PATCH /api/products/:id', () => {
  test('updates the given fields and bumps the version', async () => {
    const product = await create();
    const bakery = await insertCategory(db.pool, 'Bakery');
    const response = await asAdmin('PATCH', `/api/products/${product.id}`, {
      version: 1,
      name: 'Skim milk 1 L',
      price: '999',
      categoryId: bakery.id,
      description: '',
    });
    assert.equal(response.status, 200);
    const updated = (await response.json()) as Product;
    assert.equal(updated.name, 'Skim milk 1 L');
    assert.equal(updated.price, '999.00');
    assert.deepEqual(updated.category, { id: bakery.id, name: 'Bakery' });
    assert.equal(updated.description, '');
    assert.equal(updated.brand, product.brand);
    assert.equal(updated.version, 2);
    assert.ok(updated.updatedAt > product.updatedAt);
  });

  test('a quantity change is recorded as an adjustment with the new snapshot', async () => {
    const product = await create({ quantity: 24 });
    await asAdmin('PATCH', `/api/products/${product.id}`, { version: 1, quantity: 20, price: '1300' });
    const movements = await movementsOf(product.id);
    assert.equal(movements.length, 2);
    assert.deepEqual(movements[1], {
      type: 'adjustment',
      user_id: admin.id,
      user_full_name: 'Admin Person',
      product_name: 'Whole milk 1 L',
      product_brand: 'La Serenísima',
      unit_price: '1300.00',
      delta: -4,
      quantity_after: 20,
    });
  });

  test('sending the same quantity records no adjustment', async () => {
    const product = await create({ quantity: 24 });
    await asAdmin('PATCH', `/api/products/${product.id}`, { version: 1, quantity: 24, name: 'Renamed' });
    assert.equal((await movementsOf(product.id)).length, 1);
  });

  test('a stale version answers 409 PRODUCT_VERSION_CONFLICT with the current version and changes nothing', async () => {
    const product = await create();
    assert.equal((await asAdmin('PATCH', `/api/products/${product.id}`, { version: 1, name: 'First' })).status, 200);
    const error = await expectError(
      await asAdmin('PATCH', `/api/products/${product.id}`, { version: 1, name: 'Second', quantity: 0 }),
      409,
      'PRODUCT_VERSION_CONFLICT',
    );
    assert.equal(error.details[0]?.path, 'version');
    assert.equal((error.details[0] as { currentVersion?: number }).currentVersion, 2);
    const stored = (await (await asAdmin('GET', `/api/products/${product.id}`)).json()) as Product;
    assert.equal(stored.name, 'First');
    assert.equal(stored.quantity, product.quantity);
  });

  test('retrying an edit that already landed returns the product with 200 and records nothing twice', async () => {
    const product = await create({ quantity: 24 });
    const edit = { version: 1, name: 'Skim milk 1 L', quantity: 30, price: '999.9' };
    const first = await asAdmin('PATCH', `/api/products/${product.id}`, edit);
    assert.equal(first.status, 200);
    const edited = (await first.json()) as Product;
    assert.equal(edited.version, 2);
    const replay = await asAdmin('PATCH', `/api/products/${product.id}`, { ...edit, price: '999.90' });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), edited);
    assert.deepEqual(
      (await movementsOf(product.id)).map((movement) => movement.delta),
      [24, 6],
    );
  });

  test('two concurrent edits with the same version: exactly one wins', async () => {
    const product = await create({ quantity: 10 });
    const results = await Promise.all(
      [5, 7].map((quantity) => asAdmin('PATCH', `/api/products/${product.id}`, { version: 1, quantity })),
    );
    assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
    await Promise.all(results.map((response) => response.body?.cancel()));
    const stored = (await (await asAdmin('GET', `/api/products/${product.id}`)).json()) as Product;
    assert.equal(stored.version, 2);
    const adjustments = await movementsOf(product.id);
    assert.equal(adjustments.length, 2);
    assert.equal(adjustments[1]?.quantity_after, stored.quantity);
  });

  for (const [label, body] of [
    ['only the version', { version: 1 }],
    ['no version', { name: 'X' }],
    ['a version of 0', { version: 0, name: 'X' }],
    ['an extra field', { version: 1, sku: 'X' }],
    ['a numeric price', { version: 1, price: 10 }],
  ] as const) {
    test(`rejects ${label} with 400`, async () => {
      const product = await create();
      await expectError(await asAdmin('PATCH', `/api/products/${product.id}`, body), 400, 'VALIDATION_ERROR');
    });
  }

  test('an unknown product answers 404 and an unknown category 400', async () => {
    const product = await create();
    await expectError(await asAdmin('PATCH', `/api/products/${crypto.randomUUID()}`, { version: 1, name: 'X' }), 404, 'PRODUCT_NOT_FOUND');
    const error = await expectError(
      await asAdmin('PATCH', `/api/products/${product.id}`, { version: 1, categoryId: crypto.randomUUID() }),
      400,
      'VALIDATION_ERROR',
    );
    assert.equal(error.details[0]?.path, 'categoryId');
  });
});

describe('DELETE /api/products/:id', () => {
  test('deletes the product; its remaining stock leaves as an adjustment and the history keeps snapshots', async () => {
    const product = await create({ quantity: 5 });
    assert.equal((await asAdmin('DELETE', `/api/products/${product.id}`)).status, 204);
    await expectError(await asAdmin('DELETE', `/api/products/${product.id}`), 404, 'PRODUCT_NOT_FOUND');
    const { rows } = await db.pool.query(
      `SELECT m.type, i.product_id, i.product_name, i.delta, i.quantity_after
       FROM stock_movement_items i JOIN stock_movements m ON m.id = i.movement_id
       ORDER BY m.created_at, i.delta DESC`,
    );
    assert.deepEqual(rows, [
      { type: 'adjustment', product_id: null, product_name: 'Whole milk 1 L', delta: 5, quantity_after: 5 },
      { type: 'adjustment', product_id: null, product_name: 'Whole milk 1 L', delta: -5, quantity_after: 0 },
    ]);
  });

  test('deleting a product without stock records nothing', async () => {
    const product = await create({ quantity: 0 });
    assert.equal((await asAdmin('DELETE', `/api/products/${product.id}`)).status, 204);
    assert.equal((await db.pool.query('SELECT 1 FROM stock_movements')).rowCount, 0);
  });
});

describe('paging cost', () => {
  test('a page with a cursor costs one query, like the first page', async () => {
    for (let i = 0; i < 3; i++) await insertProduct(db.pool, dairy.id, { name: `P${i}` });
    const counting = countingPool(db.pool);
    const countingServer = await startTestServer(createTestApp({ pool: counting.pool }));
    try {
      const get = (path: string) => fetch(`${countingServer.url}${path}`, { headers: { Cookie: adminCookie } });
      let before = counting.count();
      const first = await get('/api/products?limit=1');
      const firstPageQueries = counting.count() - before;
      const next = /<([^>]+)>; rel="next"/.exec(first.headers.get('link') ?? '')?.[1];
      await first.body?.cancel();
      assert.ok(next);
      before = counting.count();
      const second = await get(next);
      assert.equal(second.status, 200);
      await second.body?.cancel();
      assert.equal(counting.count() - before, firstPageQueries);
    } finally {
      await countingServer.close();
    }
  });
});
