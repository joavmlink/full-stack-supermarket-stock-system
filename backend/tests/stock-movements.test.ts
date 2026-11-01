import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { MAX_ITEMS_PER_MOVEMENT, MAX_QUANTITY } from '../src/db/schema.js';
import { AppError } from '../src/errors.js';
import { createStockMovement } from '../src/models/movement-model.js';
import { createProduct } from '../src/models/product-model.js';
import { MAX_LINE_QUANTITY, type StockMovement } from '../src/schemas/movement-schemas.js';
import type { Product } from '../src/schemas/product-schemas.js';
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
  spreadCreatedAt,
  startTestDatabase,
  startTestServer,
  type HttpMethod,
  type TestDatabase,
  type TestServer,
  walkPages,
} from './helpers.js';

let db: TestDatabase;
let server: TestServer;
let call: ReturnType<typeof apiCaller>;
let ana: User;
let adminCookie: string;
let anaCookie: string;
let brunoCookie: string;
let categoryId: string;

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
  await insertUser(db.pool, { email: 'admin@example.com', fullName: 'Admin Person', role: 'admin' });
  ana = await insertUser(db.pool, { email: 'ana@example.com', fullName: 'Ana Employee' });
  await insertUser(db.pool, { email: 'bruno@example.com', fullName: 'Bruno Employee' });
  adminCookie = await signIn(server.url, 'admin@example.com');
  anaCookie = await signIn(server.url, 'ana@example.com');
  brunoCookie = await signIn(server.url, 'bruno@example.com');
  categoryId = (await insertCategory(db.pool, 'Dairy')).id;
});

type Line = { productId: string; quantity: number };

const movementBody = (type: string, items: unknown[], id: string = crypto.randomUUID()) => ({ id, type, items });

const post = (cookie: string, body: unknown) => call('POST', '/api/stock-movements', { cookie, body });

async function record(cookie: string, type: 'sale' | 'restock', items: Line[]): Promise<StockMovement> {
  const response = await post(cookie, movementBody(type, items));
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as StockMovement;
}

const product = (overrides: Parameters<typeof insertProduct>[2] = {}) => insertProduct(db.pool, categoryId, overrides);

async function quantities(...ids: string[]): Promise<number[]> {
  const { rows } = await db.pool.query<{ id: string; quantity: number }>(
    'SELECT id, quantity FROM products WHERE id = ANY($1::uuid[])',
    [ids],
  );
  return ids.map((id) => rows.find((row) => row.id === id)!.quantity);
}

async function movementCount(): Promise<number> {
  const { rows } = await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM stock_movements');
  return rows[0]!.n;
}

describe('access control', () => {
  test('every route needs a session; movements cannot be edited or deleted', async () => {
    const id = crypto.randomUUID();
    const routes: [HttpMethod, string, unknown][] = [
      ['GET', '/api/stock-movements', undefined],
      ['POST', '/api/stock-movements', movementBody('sale', [{ productId: id, quantity: 1 }])],
      ['GET', `/api/stock-movements/${id}`, undefined],
    ];
    for (const [method, path, body] of routes) {
      await expectError(await call(method, path, { body }), 401, 'UNAUTHENTICATED');
    }
    for (const method of ['PATCH', 'DELETE'] as const) {
      const response = await call(method, `/api/stock-movements/${id}`, { cookie: adminCookie });
      await expectError(response, 405, 'METHOD_NOT_ALLOWED');
      assert.equal(response.headers.get('allow'), 'GET, HEAD');
    }
  });

  test('admins record sales and restocks too', async () => {
    const milk = await product({ quantity: 5 });
    await record(adminCookie, 'restock', [{ productId: milk, quantity: 1 }]);
    await record(adminCookie, 'sale', [{ productId: milk, quantity: 2 }]);
    assert.deepEqual(await quantities(milk), [4]);
  });
});

describe('POST /api/stock-movements', () => {
  test('a sale subtracts every line and returns the movement with snapshots', async () => {
    const milk = await product({ brand: 'La Serenísima', name: 'Whole milk 1 L', quantity: 20, price: '1250.50' });
    const butter = await product({ brand: 'Sancor', name: 'Butter 200 g', quantity: 3, price: '2100.00' });
    const body = movementBody('sale', [
      { productId: butter, quantity: 3 },
      { productId: milk, quantity: 2 },
    ]);
    const response = await post(anaCookie, body);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('location'), `/api/stock-movements/${body.id}`);
    const movement = (await response.json()) as StockMovement;
    assert.match(movement.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(
      { ...movement, createdAt: undefined },
      {
        id: body.id,
        type: 'sale',
        user: { id: ana.id, fullName: 'Ana Employee' },
        items: [
          { product: { id: butter, name: 'Butter 200 g', brand: 'Sancor' }, unitPrice: '2100.00', delta: -3, quantityAfter: 0 },
          {
            product: { id: milk, name: 'Whole milk 1 L', brand: 'La Serenísima' },
            unitPrice: '1250.50',
            delta: -2,
            quantityAfter: 18,
          },
        ],
        createdAt: undefined,
      },
    );
    assert.deepEqual(await quantities(milk, butter), [18, 0]);
  });

  test('a restock adds every line, up to the stock limit exactly', async () => {
    const milk = await product({ quantity: 20 });
    const rice = await product({ name: 'Rice 1 kg', quantity: MAX_QUANTITY - 7 });
    const movement = await record(brunoCookie, 'restock', [
      { productId: milk, quantity: 30 },
      { productId: rice, quantity: 7 },
    ]);
    assert.deepEqual(
      movement.items.map((item) => [item.delta, item.quantityAfter]),
      [
        [30, 50],
        [7, MAX_QUANTITY],
      ],
    );
    assert.deepEqual(await quantities(milk, rice), [50, MAX_QUANTITY]);
  });

  test('every recorded change bumps the product version, so an edit based on older data is rejected', async () => {
    const milk = await product({ quantity: 20 });
    await record(anaCookie, 'sale', [{ productId: milk, quantity: 1 }]);
    const current = (await (await call('GET', `/api/products/${milk}`, { cookie: adminCookie })).json()) as Product;
    assert.equal(current.version, 2);
    const stale = await call('PATCH', `/api/products/${milk}`, { cookie: adminCookie, body: { version: 1, quantity: 0 } });
    await expectError(stale, 409, 'PRODUCT_VERSION_CONFLICT');
  });

  test('prices keep every digit through the history', async () => {
    const caviar = await product({ quantity: 1, price: '99999999.99' });
    const movement = await record(anaCookie, 'sale', [{ productId: caviar, quantity: 1 }]);
    assert.equal(movement.items[0]?.unitPrice, '99999999.99');
  });

  test('a sale without enough stock changes nothing and reports every short line', async () => {
    const milk = await product({ quantity: 5 });
    const bread = await product({ name: 'Bread', quantity: 10 });
    const butter = await product({ name: 'Butter', quantity: 0 });
    const error = await expectError(
      await post(
        anaCookie,
        movementBody('sale', [
          { productId: milk, quantity: 6 },
          { productId: bread, quantity: 10 },
          { productId: butter, quantity: 1 },
        ]),
      ),
      409,
      'INSUFFICIENT_STOCK',
    );
    assert.deepEqual(error.details, [
      { path: 'items.0.quantity', message: 'only 5 in stock', productId: milk, requested: 6, available: 5 },
      { path: 'items.2.quantity', message: 'only 0 in stock', productId: butter, requested: 1, available: 0 },
    ]);
    assert.deepEqual(await quantities(milk, bread, butter), [5, 10, 0]);
    assert.equal(await movementCount(), 0);
  });

  test('a restock past the stock limit changes nothing', async () => {
    const milk = await product({ quantity: MAX_QUANTITY - 1 });
    const bread = await product({ name: 'Bread', quantity: 0 });
    const error = await expectError(
      await post(
        anaCookie,
        movementBody('restock', [
          { productId: bread, quantity: 4 },
          { productId: milk, quantity: 2 },
        ]),
      ),
      409,
      'STOCK_LIMIT_EXCEEDED',
    );
    assert.deepEqual(error.details, [
      {
        path: 'items.1.quantity',
        message: `the stock cannot exceed ${MAX_QUANTITY}; ${MAX_QUANTITY - 1} in stock`,
        productId: milk,
        requested: 2,
        available: MAX_QUANTITY - 1,
        max: MAX_QUANTITY,
      },
    ]);
    assert.deepEqual(await quantities(milk, bread), [MAX_QUANTITY - 1, 0]);
    assert.equal(await movementCount(), 0);
  });

  test('a product that does not exist answers 400 on its lines and changes nothing', async () => {
    const milk = await product({ quantity: 5 });
    const gone = crypto.randomUUID();
    const error = await expectError(
      await post(
        anaCookie,
        movementBody('sale', [
          { productId: milk, quantity: 1 },
          { productId: gone, quantity: 1 },
        ]),
      ),
      400,
      'VALIDATION_ERROR',
    );
    assert.deepEqual(error.details, [{ path: 'items.1.productId', message: 'does not match any product' }]);
    assert.deepEqual(await quantities(milk), [5]);
    assert.equal(await movementCount(), 0);
  });

  const someId = crypto.randomUUID();
  const line = (quantity: unknown) => ({ productId: someId, quantity });
  for (const [label, body, path] of [
    ['an adjustment', movementBody('adjustment', [line(1)]), 'type'],
    ['an unknown type', movementBody('refund', [line(1)]), 'type'],
    ['no lines', movementBody('sale', []), 'items'],
    [
      `more than ${MAX_ITEMS_PER_MOVEMENT} lines`,
      movementBody(
        'sale',
        Array.from({ length: MAX_ITEMS_PER_MOVEMENT + 1 }, () => ({ productId: crypto.randomUUID(), quantity: 1 })),
      ),
      'items',
    ],
    ['the same product twice', movementBody('sale', [line(1), line(2)]), 'items.1.productId'],
    ['a quantity of 0', movementBody('sale', [line(0)]), 'items.0.quantity'],
    [`a quantity above ${MAX_LINE_QUANTITY}`, movementBody('restock', [line(MAX_LINE_QUANTITY + 1)]), 'items.0.quantity'],
    ['a fractional quantity', movementBody('sale', [line(1.5)]), 'items.0.quantity'],
    ['a quantity as text', movementBody('sale', [line('3')]), 'items.0.quantity'],
    ['a product id that is not a UUID', movementBody('sale', [{ productId: '42', quantity: 1 }]), 'items.0.productId'],
    ['an id that is not a UUID', movementBody('sale', [line(1)], 'abc'), 'id'],
    ['no id', { type: 'sale', items: [line(1)] }, 'id'],
    ['an extra field on a line', movementBody('sale', [{ ...line(1), price: '1' }]), 'items.0'],
    ['an extra field', { ...movementBody('sale', [line(1)]), userId: someId }, ''],
  ] as const) {
    test(`rejects ${label} with 400 on ${path || 'the body'}`, async () => {
      const error = await expectError(await post(anaCookie, body), 400, 'VALIDATION_ERROR');
      assert.ok(
        error.details.some((detail) => detail.path === path),
        JSON.stringify(error.details),
      );
    });
  }
});

describe('idempotent retries', () => {
  test('a retry after the first attempt used up the stock returns the stored movement with 200, not INSUFFICIENT_STOCK', async () => {
    const milk = await product({ quantity: 3 });
    const bread = await product({ name: 'Bread', quantity: 5 });
    const body = movementBody('sale', [
      { productId: milk, quantity: 3 },
      { productId: bread, quantity: 1 },
    ]);
    const first = await post(anaCookie, body);
    assert.equal(first.status, 201);
    const recorded = await first.json();
    const replay = await post(anaCookie, body);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('location'), `/api/stock-movements/${body.id}`);
    assert.deepEqual(await replay.json(), recorded);
    assert.deepEqual(await quantities(milk, bread), [0, 4]);
    assert.equal(await movementCount(), 1);
  });

  test('the same id with other lines, another type or another author answers 409 and moves nothing', async () => {
    const milk = await product({ quantity: 10 });
    const bread = await product({ name: 'Bread', quantity: 10 });
    const body = movementBody('sale', [
      { productId: milk, quantity: 2 },
      { productId: bread, quantity: 1 },
    ]);
    assert.equal((await post(anaCookie, body)).status, 201);
    const variants: [string, unknown][] = [
      [anaCookie, { ...body, items: [{ productId: milk, quantity: 3 }, body.items[1]] }],
      [anaCookie, { ...body, items: [...body.items].reverse() }],
      [anaCookie, { ...body, items: [body.items[0]] }],
      [anaCookie, { ...body, type: 'restock' }],
      [brunoCookie, body],
    ];
    for (const [cookie, variant] of variants) await expectError(await post(cookie, variant), 409, 'ALREADY_EXISTS');
    assert.deepEqual(await quantities(milk, bread), [8, 9]);
  });

  test('an id already used by another movement answers ALREADY_EXISTS before the lines are judged', async () => {
    const milk = await product({ quantity: 3 });
    const bread = await product({ name: 'Bread', quantity: 3 });
    const first = await record(anaCookie, 'sale', [{ productId: milk, quantity: 1 }]);
    const lines = [
      { productId: bread, quantity: 1 },
      { productId: crypto.randomUUID(), quantity: 1 },
    ];
    await expectError(await post(brunoCookie, movementBody('restock', lines, first.id)), 409, 'ALREADY_EXISTS');
    assert.deepEqual(await quantities(milk, bread), [2, 3]);
  });
});

describe('deleted authors', () => {
  const isUnauthenticated = (error: unknown) =>
    error instanceof AppError && error.status === 401 && error.code === 'UNAUTHENTICATED';
  const ghost = { id: '00000000-0000-4000-8000-000000000000', fullName: 'Deleted Person' };

  test('a stock form whose author was deleted mid-request answers 401 and changes nothing', async () => {
    const milk = await product({ quantity: 3 });
    const input = { id: crypto.randomUUID(), type: 'sale' as const, items: [{ productId: milk, quantity: 1 }] };
    await assert.rejects(createStockMovement(db.pool, input, ghost), isUnauthenticated);
    assert.deepEqual(await quantities(milk), [3]);
  });

  test('so does an adjustment (a product created with stock)', async () => {
    const id = crypto.randomUUID();
    const input = { id, categoryId, brand: 'Acme', name: 'Rice', description: '', quantity: 5, price: '10.00' };
    await assert.rejects(createProduct(db.pool, input, ghost), isUnauthenticated);
    const { rows } = await db.pool.query('SELECT 1 FROM products WHERE id = $1', [id]);
    assert.equal(rows.length, 0);
  });
});

describe('concurrency', () => {
  test('two concurrent sales of the last unit: exactly one wins', async () => {
    const milk = await product({ quantity: 1 });
    const results = await Promise.all(
      [anaCookie, brunoCookie].map((cookie) => post(cookie, movementBody('sale', [{ productId: milk, quantity: 1 }]))),
    );
    assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
    await expectError(results.find((response) => response.status === 409)!, 409, 'INSUFFICIENT_STOCK');
    await results.find((response) => response.status === 201)!.body?.cancel();
    assert.deepEqual(await quantities(milk), [0]);
    assert.equal(await movementCount(), 1);
  });

  test('concurrent forms that list the same products in opposite orders all apply', async () => {
    const milk = await product({ quantity: 100 });
    const bread = await product({ name: 'Bread', quantity: 100 });
    const lines = [
      { productId: milk, quantity: 1 },
      { productId: bread, quantity: 2 },
    ];
    const forms = Array.from({ length: 6 }, (_, index) =>
      movementBody('sale', index % 2 === 0 ? lines : lines.toReversed()),
    );
    const results = await Promise.all(forms.map((body, index) => post(index % 2 === 0 ? anaCookie : brunoCookie, body)));
    assert.deepEqual(
      results.map((response) => response.status),
      forms.map(() => 201),
    );
    await Promise.all(results.map((response) => response.body?.cancel()));
    assert.deepEqual(await quantities(milk, bread), [94, 88]);
  });
});

describe('GET /api/stock-movements/:id', () => {
  test('employees read their own movements; anyone else’s answers 404; admins read all', async () => {
    const milk = await product({ quantity: 10 });
    const own = await record(anaCookie, 'sale', [{ productId: milk, quantity: 1 }]);
    const path = `/api/stock-movements/${own.id}`;
    assert.deepEqual(await (await call('GET', path, { cookie: anaCookie })).json(), own);
    assert.deepEqual(await (await call('GET', path, { cookie: adminCookie })).json(), own);
    await expectError(await call('GET', path, { cookie: brunoCookie }), 404, 'STOCK_MOVEMENT_NOT_FOUND');
    await expectError(
      await call('GET', `/api/stock-movements/${crypto.randomUUID()}`, { cookie: adminCookie }),
      404,
      'STOCK_MOVEMENT_NOT_FOUND',
    );
    await expectError(await call('GET', '/api/stock-movements/42', { cookie: adminCookie }), 400, 'VALIDATION_ERROR');
  });

  test('keeps the author’s and the product’s snapshots after both are deleted', async () => {
    const milk = await product({ brand: 'Acme', name: 'Whole milk 1 L', quantity: 10, price: '1250.00' });
    const sale = await record(anaCookie, 'sale', [{ productId: milk, quantity: 4 }]);
    assert.equal((await call('DELETE', `/api/employees/${ana.id}`, { cookie: adminCookie })).status, 204);
    assert.equal((await call('DELETE', `/api/products/${milk}`, { cookie: adminCookie })).status, 204);
    const stored = (await (await call('GET', `/api/stock-movements/${sale.id}`, { cookie: adminCookie })).json()) as StockMovement;
    assert.deepEqual(stored.user, { id: null, fullName: 'Ana Employee' });
    assert.deepEqual(stored.items, [
      { product: { id: null, name: 'Whole milk 1 L', brand: 'Acme' }, unitPrice: '1250.00', delta: -4, quantityAfter: 6 },
    ]);
  });
});

describe('GET /api/stock-movements', () => {
  /** Ana records 5 movements, Bruno 3 and the admin 1 adjustment; created_at gets ties. */
  async function seedHistory() {
    const milk = await product({ quantity: 100 });
    for (let index = 0; index < 5; index += 1) {
      await record(anaCookie, index % 2 === 0 ? 'sale' : 'restock', [{ productId: milk, quantity: 1 }]);
    }
    for (let index = 0; index < 3; index += 1) await record(brunoCookie, 'sale', [{ productId: milk, quantity: 1 }]);
    const current = (await (await call('GET', `/api/products/${milk}`, { cookie: adminCookie })).json()) as Product;
    const edit = await call('PATCH', `/api/products/${milk}`, {
      cookie: adminCookie,
      body: { version: current.version, quantity: 50 },
    });
    assert.equal(edit.status, 200);
    await spreadCreatedAt(db.pool, 'stock_movements', 4);
  }

  async function expectedIds(where = 'true', params: unknown[] = []): Promise<string[]> {
    const { rows } = await db.pool.query<{ id: string }>(
      `SELECT id FROM stock_movements WHERE ${where} ORDER BY created_at DESC, id DESC`,
      params,
    );
    return rows.map((row) => row.id);
  }

  test('admins page through every movement, newest first, across created_at ties', async () => {
    await seedHistory();
    const { ids, pages } = await walkPages(call, '/api/stock-movements?limit=2', adminCookie);
    assert.deepEqual(ids, await expectedIds());
    assert.equal(ids.length, 9);
    assert.equal(pages, 5);
  });

  test('employees page through only their own movements', async () => {
    await seedHistory();
    const { ids } = await walkPages(call, '/api/stock-movements?limit=2', anaCookie);
    assert.deepEqual(ids, await expectedIds('user_id = $1', [ana.id]));
    assert.equal(ids.length, 5);
  });

  test('filters by type and keeps the filter in the next link', async () => {
    await seedHistory();
    const sales = await walkPages(call, '/api/stock-movements?limit=1&type=sale', adminCookie);
    assert.deepEqual(sales.ids, await expectedIds(`type = 'sale'`));
    assert.equal(sales.ids.length, 6);
    const adjustments = await walkPages(call, '/api/stock-movements?type=adjustment', adminCookie);
    assert.deepEqual(adjustments.ids, await expectedIds(`type = 'adjustment'`));
    const anasRestocks = await walkPages(call, '/api/stock-movements?type=restock', anaCookie);
    assert.deepEqual(anasRestocks.ids, await expectedIds(`type = 'restock' AND user_id = $1`, [ana.id]));
  });

  test('lists include the lines; an empty history is an empty list', async () => {
    const empty = await call('GET', '/api/stock-movements', { cookie: anaCookie });
    assert.deepEqual(await empty.json(), []);
    assert.equal(empty.headers.get('link'), null);
    const milk = await product({ quantity: 10 });
    const sale = await record(anaCookie, 'sale', [{ productId: milk, quantity: 2 }]);
    assert.deepEqual(await (await call('GET', '/api/stock-movements', { cookie: anaCookie })).json(), [sale]);
  });

  test('a cursor outside the viewer’s list answers 400, so another employee’s ids reveal nothing', async () => {
    const milk = await product({ quantity: 10 });
    const brunos = await record(brunoCookie, 'sale', [{ productId: milk, quantity: 1 }]);
    for (const before of [brunos.id, crypto.randomUUID()]) {
      const error = await expectError(
        await call('GET', `/api/stock-movements?before=${before}`, { cookie: anaCookie }),
        400,
        'VALIDATION_ERROR',
      );
      assert.equal(error.details[0]?.path, 'before');
    }
    assert.equal((await call('GET', `/api/stock-movements?before=${brunos.id}`, { cookie: adminCookie })).status, 200);
  });

  for (const query of ['type=refund', 'limit=0', 'limit=101', 'before=42', 'userId=x']) {
    test(`rejects ?${query} with 400`, async () => {
      await expectError(await call('GET', `/api/stock-movements?${query}`, { cookie: adminCookie }), 400, 'VALIDATION_ERROR');
    });
  }
});

describe('stats', () => {
  test('a recorded sale counts in the employee’s stats and in the stock totals', async () => {
    const milk = await product({ quantity: 10, price: '100.00' });
    await record(anaCookie, 'sale', [{ productId: milk, quantity: 4 }]);
    const stats = (await (await call('GET', '/api/stats', { cookie: anaCookie })).json()) as Stats;
    assert.equal(stats.movements.sale, 1);
    assert.equal(stats.products.totalUnits, 6);
    assert.equal(stats.products.inventoryValue, '600.00');
  });
});
