import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Category } from '../src/schemas/category-schemas.js';
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
  walkPages,
  type TestServer,
} from './helpers.js';

let db: TestDatabase;
let server: TestServer;
let call: ReturnType<typeof apiCaller>;
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
  await insertUser(db.pool, { email: 'employee@example.com' });
  adminCookie = await signIn(server.url, 'admin@example.com');
  employeeCookie = await signIn(server.url, 'employee@example.com');
});

const asAdmin = (method: HttpMethod, path: string, body?: unknown) => call(method, path, { cookie: adminCookie, body });

describe('access control', () => {
  test('employees read categories; only admins change them', async () => {
    const category = await insertCategory(db.pool, 'Dairy');
    assert.equal((await call('GET', '/api/categories', { cookie: employeeCookie })).status, 200);
    assert.equal((await call('GET', `/api/categories/${category.id}`, { cookie: employeeCookie })).status, 200);
    const writes: [HttpMethod, string, unknown][] = [
      ['POST', '/api/categories', { id: crypto.randomUUID(), name: 'Bakery' }],
      ['PATCH', `/api/categories/${category.id}`, { name: 'Milk' }],
      ['DELETE', `/api/categories/${category.id}`, undefined],
    ];
    for (const [method, path, body] of writes) {
      await expectError(await call(method, path, { cookie: employeeCookie, body }), 403, 'FORBIDDEN');
      await expectError(await call(method, path, { body }), 401, 'UNAUTHENTICATED');
    }
    await expectError(await call('GET', '/api/categories'), 401, 'UNAUTHENTICATED');
  });

  test('unsupported methods answer 405', async () => {
    const response = await asAdmin('PUT', '/api/categories', {});
    assert.equal(response.headers.get('allow'), 'GET, HEAD, POST');
    await expectError(response, 405, 'METHOD_NOT_ALLOWED');
  });
});

describe('POST /api/categories', () => {
  test('creates a category with 201 and a Location header', async () => {
    const id = crypto.randomUUID();
    const response = await asAdmin('POST', '/api/categories', { id, name: '  Dairy  ' });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('location'), `/api/categories/${id}`);
    const category = (await response.json()) as Category;
    assert.equal(category.id, id);
    assert.equal(category.name, 'Dairy');
  });

  test('names are NFC-normalized, so the same text in another Unicode form is a duplicate', async () => {
    const composed = 'Café';
    const decomposed = 'Café';
    const response = await asAdmin('POST', '/api/categories', { id: crypto.randomUUID(), name: decomposed });
    assert.equal(((await response.json()) as Category).name, composed);
    await expectError(
      await asAdmin('POST', '/api/categories', { id: crypto.randomUUID(), name: composed }),
      409,
      'CATEGORY_NAME_TAKEN',
    );
  });

  test('a trailing slash does not end up in the Location header', async () => {
    const id = crypto.randomUUID();
    const response = await asAdmin('POST', '/api/categories/', { id, name: 'Bakery' });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('location'), `/api/categories/${id}`);
  });

  test('a name taken (ignoring case) answers 409 CATEGORY_NAME_TAKEN', async () => {
    await insertCategory(db.pool, 'Dairy');
    await expectError(await asAdmin('POST', '/api/categories', { id: crypto.randomUUID(), name: 'DAIRY' }), 409, 'CATEGORY_NAME_TAKEN');
  });

  test('repeating the same create returns the stored category with 200; another name on that id answers 409', async () => {
    const id = crypto.randomUUID();
    const first = await asAdmin('POST', '/api/categories', { id, name: 'Dairy' });
    assert.equal(first.status, 201);
    const created = await first.json();
    const replay = await asAdmin('POST', '/api/categories', { id, name: ' Dairy ' });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('location'), `/api/categories/${id}`);
    assert.deepEqual(await replay.json(), created);
    await expectError(await asAdmin('POST', '/api/categories', { id, name: 'Bakery' }), 409, 'ALREADY_EXISTS');
  });

  test('a replay after the category was renamed answers 409', async () => {
    const id = crypto.randomUUID();
    assert.equal((await asAdmin('POST', '/api/categories', { id, name: 'Dairy' })).status, 201);
    assert.equal((await asAdmin('PATCH', `/api/categories/${id}`, { name: 'Milk' })).status, 200);
    await expectError(await asAdmin('POST', '/api/categories', { id, name: 'Dairy' }), 409, 'ALREADY_EXISTS');
  });

  for (const [label, body] of [
    ['an empty name', { id: crypto.randomUUID(), name: '   ' }],
    ['a name longer than 60', { id: crypto.randomUUID(), name: 'x'.repeat(61) }],
    ['a name with a null character', { id: crypto.randomUUID(), name: 'Dai\u0000ry' }],
    ['a missing id', { name: 'Dairy' }],
    ['an extra field', { id: crypto.randomUUID(), name: 'Dairy', color: 'blue' }],
  ] as const) {
    test(`rejects ${label} with 400`, async () => {
      await expectError(await asAdmin('POST', '/api/categories', body), 400, 'VALIDATION_ERROR');
    });
  }
});

describe('GET /api/categories', () => {
  test('walks every page newest first without duplicates, including created_at ties', async () => {
    for (let i = 0; i < 5; i++) await insertCategory(db.pool, `C${i}`);
    await spreadCreatedAt(db.pool, 'categories', 2);
    const { rows } = await db.pool.query<{ id: string }>('SELECT id FROM categories ORDER BY created_at DESC, id DESC');
    const ids = rows.map((row) => row.id);
    const { ids: seen } = await walkPages(call, '/api/categories?limit=2', adminCookie);
    assert.deepEqual(seen, ids);
  });

  test('an unknown cursor answers 400', async () => {
    await expectError(await asAdmin('GET', `/api/categories?before=${crypto.randomUUID()}`), 400, 'VALIDATION_ERROR');
  });
});

describe('GET /api/categories/:id', () => {
  test('answers 404 for an unknown id and 400 for an invalid one', async () => {
    await expectError(await asAdmin('GET', `/api/categories/${crypto.randomUUID()}`), 404, 'CATEGORY_NOT_FOUND');
    await expectError(await asAdmin('GET', '/api/categories/abc'), 400, 'VALIDATION_ERROR');
  });
});

describe('PATCH /api/categories/:id', () => {
  test('renames a category', async () => {
    const category = await insertCategory(db.pool, 'Dairy');
    const response = await asAdmin('PATCH', `/api/categories/${category.id}`, { name: 'Dairy & eggs' });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as Category).name, 'Dairy & eggs');
  });

  test('a taken name answers 409, an unknown id 404', async () => {
    const category = await insertCategory(db.pool, 'Dairy');
    await insertCategory(db.pool, 'Bakery');
    await expectError(await asAdmin('PATCH', `/api/categories/${category.id}`, { name: 'bakery' }), 409, 'CATEGORY_NAME_TAKEN');
    await expectError(await asAdmin('PATCH', `/api/categories/${crypto.randomUUID()}`, { name: 'X' }), 404, 'CATEGORY_NOT_FOUND');
  });

  test('renaming to the same name with another case is allowed', async () => {
    const category = await insertCategory(db.pool, 'dairy');
    assert.equal((await asAdmin('PATCH', `/api/categories/${category.id}`, { name: 'Dairy' })).status, 200);
  });
});

describe('DELETE /api/categories/:id', () => {
  test('deletes an empty category; a second delete answers 404', async () => {
    const category = await insertCategory(db.pool, 'Dairy');
    assert.equal((await asAdmin('DELETE', `/api/categories/${category.id}`)).status, 204);
    await expectError(await asAdmin('DELETE', `/api/categories/${category.id}`), 404, 'CATEGORY_NOT_FOUND');
  });

  test('a category with products answers 409 CATEGORY_IN_USE and is kept', async () => {
    const category = await insertCategory(db.pool, 'Dairy');
    await insertProduct(db.pool, category.id);
    await expectError(await asAdmin('DELETE', `/api/categories/${category.id}`), 409, 'CATEGORY_IN_USE');
    assert.equal((await db.pool.query('SELECT 1 FROM categories WHERE id = $1', [category.id])).rowCount, 1);
  });
});
