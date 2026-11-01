import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { User } from '../src/schemas/user-schemas.js';
import {
  apiCaller,
  BREACHED_PASSWORD,
  createTestApp,
  expectError,
  fakeBreachCheck,
  insertUser,
  JSON_HEADERS,
  resetDatabase,
  sessionUser,
  signIn,
  spreadCreatedAt,
  startTestDatabase,
  startTestServer,
  STRONG_PASSWORD,
  walkPages,
  type HttpMethod,
  type TestDatabase,
  type TestServer,
} from './helpers.js';

let db: TestDatabase;
let server: TestServer;
let call: ReturnType<typeof apiCaller>;
const breachCheck = fakeBreachCheck([BREACHED_PASSWORD]);
let adminCookie: string;
let admin: User;

before(async () => {
  db = await startTestDatabase();
  server = await startTestServer(createTestApp({ pool: db.pool, breachCheck }));
  call = apiCaller(server.url);
});

after(async () => {
  await server.close();
  await db.close();
});

beforeEach(async () => {
  await resetDatabase(db.pool);
  breachCheck.calls.length = 0;
  admin = await insertUser(db.pool, { email: 'admin@example.com', fullName: 'Admin User', role: 'admin' });
  adminCookie = await signIn(server.url, 'admin@example.com');
});

const asAdmin = (method: HttpMethod, path: string, body?: unknown) => call(method, path, { cookie: adminCookie, body });

const newEmployee = (overrides: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  fullName: 'Lucía Fernández',
  email: 'lucia@example.com',
  password: STRONG_PASSWORD,
  ...overrides,
});

describe('access control', () => {
  const routes: [HttpMethod, string][] = [
    ['GET', '/api/employees'],
    ['POST', '/api/employees'],
    ['GET', `/api/employees/${crypto.randomUUID()}`],
    ['PATCH', `/api/employees/${crypto.randomUUID()}`],
    ['DELETE', `/api/employees/${crypto.randomUUID()}`],
  ];

  for (const [method, path] of routes) {
    test(`${method} ${path.replace(/[0-9a-f-]{36}/, ':id')} answers 401 without a session`, async () => {
      await expectError(await call(method, path, { body: method === 'POST' || method === 'PATCH' ? {} : undefined }), 401, 'UNAUTHENTICATED');
    });

    test(`${method} ${path.replace(/[0-9a-f-]{36}/, ':id')} answers 403 for an employee`, async () => {
      await insertUser(db.pool, { email: 'employee@example.com' });
      const cookie = await signIn(server.url, 'employee@example.com');
      const body = method === 'POST' || method === 'PATCH' ? {} : undefined;
      await expectError(await call(method, path, { cookie, body }), 403, 'FORBIDDEN');
    });
  }

  test('an employee cannot read or change another employee (cross-access)', async () => {
    const other = await insertUser(db.pool, { email: 'other@example.com' });
    await insertUser(db.pool, { email: 'employee@example.com' });
    const cookie = await signIn(server.url, 'employee@example.com');
    await expectError(await call('GET', `/api/employees/${other.id}`, { cookie }), 403, 'FORBIDDEN');
    await expectError(await call('PATCH', `/api/employees/${other.id}`, { cookie, body: { fullName: 'X' } }), 403, 'FORBIDDEN');
    await expectError(await call('DELETE', `/api/employees/${other.id}`, { cookie }), 403, 'FORBIDDEN');
    assert.equal((await db.pool.query('SELECT 1 FROM users WHERE id = $1', [other.id])).rowCount, 1);
  });

  test('admin accounts are not reachable through /employees', async () => {
    await expectError(await asAdmin('GET', `/api/employees/${admin.id}`), 404, 'EMPLOYEE_NOT_FOUND');
    await expectError(await asAdmin('PATCH', `/api/employees/${admin.id}`, { fullName: 'Hijack' }), 404, 'EMPLOYEE_NOT_FOUND');
    await expectError(await asAdmin('DELETE', `/api/employees/${admin.id}`), 404, 'EMPLOYEE_NOT_FOUND');
    const list = (await (await asAdmin('GET', '/api/employees')).json()) as User[];
    assert.deepEqual(list, []);
  });

  test('unsupported methods answer 405 with Allow', async () => {
    const collection = await asAdmin('PUT', '/api/employees', {});
    assert.equal(collection.headers.get('allow'), 'GET, HEAD, POST');
    await expectError(collection, 405, 'METHOD_NOT_ALLOWED');
    const item = await asAdmin('PUT', `/api/employees/${crypto.randomUUID()}`, {});
    assert.equal(item.headers.get('allow'), 'GET, HEAD, PATCH, DELETE');
    await expectError(item, 405, 'METHOD_NOT_ALLOWED');
  });
});

describe('POST /api/employees', () => {
  test('creates an employee with 201, a Location header and no password in the response', async () => {
    const body = newEmployee({ email: '  Lucia@Example.COM ' });
    const response = await asAdmin('POST', '/api/employees', body);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('location'), `/api/employees/${body.id}`);
    const employee = (await response.json()) as User & Record<string, unknown>;
    assert.equal(employee.id, body.id);
    assert.equal(employee.email, 'lucia@example.com');
    assert.equal(employee.role, 'employee');
    assert.deepEqual(Object.keys(employee).sort(), ['createdAt', 'email', 'fullName', 'id', 'role', 'updatedAt']);
    assert.deepEqual(breachCheck.calls, [STRONG_PASSWORD]);
    // The new employee can sign in with the password the admin chose.
    await signIn(server.url, 'lucia@example.com');
  });

  for (const [label, override, path] of [
    ['a password shorter than 15 characters', { password: 'short password' }, 'password'],
    ['a password longer than 128 characters', { password: 'x'.repeat(129) }, 'password'],
    ['an invalid email', { email: 'lucia' }, 'email'],
    ['an empty full name', { fullName: '   ' }, 'fullName'],
    ['an id that is not a UUID', { id: '123' }, 'id'],
    ['an extra field', { role: 'admin' }, ''],
  ] as const) {
    test(`rejects ${label} with 400`, async () => {
      const error = await expectError(await asAdmin('POST', '/api/employees', newEmployee(override)), 400, 'VALIDATION_ERROR');
      assert.ok(error.details.some((detail) => detail.path === path), JSON.stringify(error.details));
    });
  }

  for (const [label, password, reason] of [
    ['a common password', '1q2w3e4r5t6y7u8i9o0p', /commonly used/],
    ['a repeated pattern', 'abababababababab', /pattern/],
    ['the employee name', 'LuciaFernandez2026', /close/],
    ['a breached password', BREACHED_PASSWORD, /data breach/],
  ] as const) {
    test(`rejects ${label} and says why`, async () => {
      const error = await expectError(await asAdmin('POST', '/api/employees', newEmployee({ password })), 400, 'VALIDATION_ERROR');
      assert.equal(error.details[0]?.path, 'password');
      assert.match(error.details[0]?.message ?? '', reason);
      assert.equal((await db.pool.query(`SELECT 1 FROM users WHERE role = 'employee'`)).rowCount, 0);
    });
  }

  test('still creates the employee when the breach check is unavailable', async () => {
    const app = createTestApp({ pool: db.pool, breachCheck: async () => 'unavailable' });
    const other = await startTestServer(app);
    try {
      const cookie = await signIn(other.url, 'admin@example.com');
      const response = await fetch(`${other.url}/api/employees`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, Cookie: cookie },
        body: JSON.stringify(newEmployee()),
      });
      assert.equal(response.status, 201);
      await response.body?.cancel();
    } finally {
      await other.close();
    }
  });

  test('a taken email answers 409 EMAIL_TAKEN, ignoring case', async () => {
    await insertUser(db.pool, { email: 'lucia@example.com' });
    await expectError(await asAdmin('POST', '/api/employees', newEmployee({ email: 'LUCIA@example.com' })), 409, 'EMAIL_TAKEN');
  });

  test('repeating the same create returns the stored employee with 200 and creates nothing else', async () => {
    const body = newEmployee();
    const first = await asAdmin('POST', '/api/employees', body);
    assert.equal(first.status, 201);
    const created = await first.json();
    const replay = await asAdmin('POST', '/api/employees', { ...body, email: 'LUCIA@example.com' });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('location'), `/api/employees/${body.id}`);
    assert.deepEqual(await replay.json(), created);
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM users WHERE role = 'employee'`);
    assert.equal(rows[0].n, 1);
  });

  for (const [label, change] of [
    ['another email', { email: 'another@example.com' }],
    ['another name', { fullName: 'Lucía Gómez' }],
    ['another password', { password: 'piñata party at noon' }],
  ] as const) {
    test(`the same id with ${label} answers 409 ALREADY_EXISTS`, async () => {
      const body = newEmployee();
      assert.equal((await asAdmin('POST', '/api/employees', body)).status, 201);
      await expectError(await asAdmin('POST', '/api/employees', { ...body, ...change }), 409, 'ALREADY_EXISTS');
    });
  }

  test('an id that belongs to an admin answers 409, never the admin', async () => {
    await expectError(
      await asAdmin('POST', '/api/employees', newEmployee({ id: admin.id, fullName: 'Admin User', email: 'admin@example.com' })),
      409,
      'ALREADY_EXISTS',
    );
  });

  test('concurrent creates: unique ids all succeed; the same email succeeds once', async () => {
    const unique = await Promise.all(
      Array.from({ length: 5 }, (_, i) => asAdmin('POST', '/api/employees', newEmployee({ email: `e${i}@example.com` }))),
    );
    assert.deepEqual(unique.map((response) => response.status), [201, 201, 201, 201, 201]);
    const racing = await Promise.all(
      Array.from({ length: 3 }, () => asAdmin('POST', '/api/employees', newEmployee({ email: 'same@example.com' }))),
    );
    assert.deepEqual(racing.map((response) => response.status).sort(), [201, 409, 409]);
    await Promise.all([...unique, ...racing].map((response) => response.body?.cancel()));
  });
});

describe('GET /api/employees', () => {
  async function createEmployees(count: number) {
    const created: User[] = [];
    for (let i = 0; i < count; i++) created.push(await insertUser(db.pool, { email: `e${i}@example.com` }));
    return created;
  }

  const walk = (path: string) => walkPages(call, path, adminCookie);

  test('lists employees newest first and walks every page through Link without duplicates', async () => {
    await createEmployees(5);
    await spreadCreatedAt(db.pool, 'users', 3);
    const { rows } = await db.pool.query<{ id: string }>(
      `SELECT id FROM users WHERE role = 'employee' ORDER BY created_at DESC, id DESC`,
    );
    const { ids, pages } = await walk('/api/employees?limit=2');
    assert.equal(pages, 3);
    assert.deepEqual(ids, rows.map((row) => row.id));
  });

  test('pages correctly when created_at ties, ordering by id', async () => {
    await createEmployees(5);
    await db.pool.query(`UPDATE users SET created_at = '2026-01-01T00:00:00.123456Z' WHERE role = 'employee'`);
    const { rows } = await db.pool.query<{ id: string }>(`SELECT id FROM users WHERE role = 'employee' ORDER BY id DESC`);
    const { ids } = await walk('/api/employees?limit=2');
    assert.deepEqual(ids, rows.map((row) => row.id));
  });

  test('defaults to 20 per page and caps at 100', async () => {
    await createEmployees(21);
    const first = await asAdmin('GET', '/api/employees');
    assert.equal(((await first.json()) as User[]).length, 20);
    assert.match(first.headers.get('link') ?? '', /limit=20&before=/);
    assert.equal(((await (await asAdmin('GET', '/api/employees?limit=100')).json()) as User[]).length, 21);
  });

  for (const query of ['limit=0', 'limit=101', 'limit=abc', 'limit=1&limit=2', 'before=not-a-uuid', 'sort=name']) {
    test(`rejects ?${query} with 400`, async () => {
      await expectError(await asAdmin('GET', `/api/employees?${query}`), 400, 'VALIDATION_ERROR');
    });
  }

  test('rejects an unknown cursor with 400', async () => {
    const error = await expectError(await asAdmin('GET', `/api/employees?before=${crypto.randomUUID()}`), 400, 'VALIDATION_ERROR');
    assert.equal(error.details[0]?.path, 'before');
  });

  test('rejects an admin id as cursor', async () => {
    await expectError(await asAdmin('GET', `/api/employees?before=${admin.id}`), 400, 'VALIDATION_ERROR');
  });
});

describe('GET /api/employees/:id', () => {
  test('returns one employee', async () => {
    const employee = await insertUser(db.pool, { email: 'lucia@example.com' });
    const response = await asAdmin('GET', `/api/employees/${employee.id}`);
    assert.deepEqual(await response.json(), employee);
  });

  test('an unknown id answers 404, an invalid one 400, a malformed URL 400', async () => {
    await expectError(await asAdmin('GET', `/api/employees/${crypto.randomUUID()}`), 404, 'EMPLOYEE_NOT_FOUND');
    await expectError(await asAdmin('GET', '/api/employees/123'), 400, 'VALIDATION_ERROR');
    await expectError(await asAdmin('GET', '/api/employees/%E0%A4%A'), 400, 'BAD_REQUEST');
  });
});

describe('PATCH /api/employees/:id', () => {
  test('updates the name and email', async () => {
    const employee = await insertUser(db.pool, { email: 'lucia@example.com' });
    const response = await asAdmin('PATCH', `/api/employees/${employee.id}`, { fullName: 'Lucía F.', email: 'LF@example.com' });
    assert.equal(response.status, 200);
    const updated = (await response.json()) as User;
    assert.equal(updated.fullName, 'Lucía F.');
    assert.equal(updated.email, 'lf@example.com');
    assert.ok(updated.updatedAt > employee.updatedAt);
    assert.equal(updated.createdAt, employee.createdAt);
  });

  test('a new password works, the old one does not, and existing sessions are revoked', async () => {
    const employee = await insertUser(db.pool, { email: 'lucia@example.com' });
    const employeeCookie = await signIn(server.url, 'lucia@example.com');
    const response = await asAdmin('PATCH', `/api/employees/${employee.id}`, { password: 'a brand new long passphrase' });
    assert.equal(response.status, 200);
    await response.body?.cancel();
    assert.equal(await sessionUser(server.url, employeeCookie), null);
    await signIn(server.url, 'lucia@example.com', 'a brand new long passphrase');
    await assert.rejects(signIn(server.url, 'lucia@example.com'), /401/);
    // The admin's own session is untouched.
    assert.notEqual(await sessionUser(server.url, adminCookie), null);
  });

  test('changing only the name keeps the employee signed in', async () => {
    const employee = await insertUser(db.pool, { email: 'lucia@example.com' });
    const employeeCookie = await signIn(server.url, 'lucia@example.com');
    await (await asAdmin('PATCH', `/api/employees/${employee.id}`, { fullName: 'Lucía' })).body?.cancel();
    assert.notEqual(await sessionUser(server.url, employeeCookie), null);
  });

  test('checks a new password against the new name and email', async () => {
    const employee = await insertUser(db.pool, { email: 'lucia@example.com' });
    const error = await expectError(
      await asAdmin('PATCH', `/api/employees/${employee.id}`, { fullName: 'Marta Gómez', password: 'MartaGomez123456' }),
      400,
      'VALIDATION_ERROR',
    );
    assert.match(error.details[0]?.message ?? '', /close/);
  });

  test('a taken email answers 409, an empty body 400 and an unknown id 404', async () => {
    const employee = await insertUser(db.pool, { email: 'lucia@example.com' });
    await insertUser(db.pool, { email: 'taken@example.com' });
    await expectError(await asAdmin('PATCH', `/api/employees/${employee.id}`, { email: 'taken@example.com' }), 409, 'EMAIL_TAKEN');
    await expectError(await asAdmin('PATCH', `/api/employees/${employee.id}`, {}), 400, 'VALIDATION_ERROR');
    await expectError(await asAdmin('PATCH', `/api/employees/${employee.id}`, { role: 'admin' }), 400, 'VALIDATION_ERROR');
    await expectError(await asAdmin('PATCH', `/api/employees/${crypto.randomUUID()}`, { fullName: 'X' }), 404, 'EMPLOYEE_NOT_FOUND');
  });
});

describe('DELETE /api/employees/:id', () => {
  test('deletes the employee and their sessions; a second delete answers 404', async () => {
    const employee = await insertUser(db.pool, { email: 'lucia@example.com' });
    const employeeCookie = await signIn(server.url, 'lucia@example.com');
    const response = await asAdmin('DELETE', `/api/employees/${employee.id}`);
    assert.equal(response.status, 204);
    assert.equal(await sessionUser(server.url, employeeCookie), null);
    await expectError(await asAdmin('DELETE', `/api/employees/${employee.id}`), 404, 'EMPLOYEE_NOT_FOUND');
  });
});
