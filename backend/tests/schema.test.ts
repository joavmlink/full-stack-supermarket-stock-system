import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ensureSchema } from '../src/db/schema.js';
import { countingPool, resetDatabase, startTestDatabase, type TestDatabase } from './helpers.js';

let db: TestDatabase;

before(async () => {
  db = await startTestDatabase();
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetDatabase(db.pool);
});

async function constraintOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { constraint?: string }).constraint;
  }
  assert.fail('expected the statement to violate a constraint');
}

async function insertUser(overrides: Record<string, unknown> = {}) {
  const values = { full_name: 'Test User', email: 'user@example.com', password_hash: 'x', role: 'employee', ...overrides };
  const { rows } = await db.pool.query<{ id: string }>(
    'INSERT INTO users (full_name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
    [values.full_name, values.email, values.password_hash, values.role],
  );
  return rows[0]!.id;
}

async function insertCategory(name = 'Dairy') {
  const { rows } = await db.pool.query<{ id: string }>('INSERT INTO categories (name) VALUES ($1) RETURNING id', [name]);
  return rows[0]!.id;
}

function insertProduct(categoryId: string, overrides: Record<string, unknown> = {}) {
  const values = { brand: 'Brand', name: 'Milk', quantity: 1, price: '10.00', ...overrides };
  return db.pool.query(
    'INSERT INTO products (category_id, brand, name, quantity, price) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [categoryId, values.brand, values.name, values.quantity, values.price],
  );
}

describe('schema', () => {
  test('is idempotent', async () => {
    await ensureSchema(db.pool);
    await ensureSchema(db.pool);
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    assert.deepEqual(
      rows.map((row) => row.table_name),
      ['categories', 'products', 'rate_limits', 'schema_version', 'sessions', 'stock_movement_items', 'stock_movements', 'users'],
    );
  });

  test('a current schema costs one read and runs no DDL; a different one runs it again', async () => {
    const indexExists = async () =>
      (await db.pool.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'rate_limits_reset_at_idx'`)).rowCount === 1;
    await db.pool.query('DROP INDEX rate_limits_reset_at_idx');

    const { pool, count } = countingPool(db.pool);
    await ensureSchema(pool);
    assert.equal(count(), 1);
    assert.equal(await indexExists(), false, 'the statements did not run');

    await db.pool.query(`UPDATE schema_version SET hash = 'another schema'`);
    await ensureSchema(db.pool);
    assert.equal(await indexExists(), true);
  });

  test('a database without the version table gets the whole schema', async () => {
    await db.pool.query('DROP TABLE schema_version');
    await ensureSchema(db.pool);
    const { rows } = await db.pool.query<{ hash: string }>('SELECT hash FROM schema_version');
    assert.match(rows[0]?.hash ?? '', /^[0-9a-f]{64}$/);
    const { pool, count } = countingPool(db.pool);
    await ensureSchema(pool);
    assert.equal(count(), 1);
  });

  test('generates UUID ids and timestamps', async () => {
    const id = await insertUser();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const { rows } = await db.pool.query<{ created_at: Date }>('SELECT created_at FROM users WHERE id = $1', [id]);
    assert.ok(rows[0]!.created_at instanceof Date);
  });

  test('stores prices as exact decimals returned as strings', async () => {
    const { rows } = await insertProduct(await insertCategory(), { price: '1234.5' });
    assert.equal(rows[0].price, '1234.50');
  });

  test('enforces the user constraints', async () => {
    assert.equal(await constraintOf(insertUser({ role: 'owner' })), 'users_role_valid');
    assert.equal(await constraintOf(insertUser({ email: 'Upper@Example.com' })), 'users_email_lowercase');
    assert.equal(await constraintOf(insertUser({ full_name: '' })), 'users_full_name_length');
    await insertUser();
    assert.equal(await constraintOf(insertUser()), 'users_email_key');
  });

  test('enforces unique category names ignoring case', async () => {
    await insertCategory('Dairy');
    assert.equal(await constraintOf(insertCategory('DAIRY')), 'categories_name_key');
    assert.equal(await constraintOf(insertCategory('')), 'categories_name_length');
  });

  test('enforces the product constraints', async () => {
    const categoryId = await insertCategory();
    assert.equal(await constraintOf(insertProduct(categoryId, { quantity: -1 })), 'products_quantity_range');
    assert.equal(await constraintOf(insertProduct(categoryId, { quantity: 1_000_001 })), 'products_quantity_range');
    assert.equal(await constraintOf(insertProduct(categoryId, { price: '-0.01' })), 'products_price_non_negative');
    assert.equal(await constraintOf(insertProduct(categoryId, { brand: '' })), 'products_brand_length');
    assert.equal(
      await constraintOf(insertProduct('00000000-0000-4000-8000-000000000000')),
      'products_category_id_fkey',
    );
  });

  test('every product update bumps version and refreshes updated_at, whoever writes it', async () => {
    const { rows } = await insertProduct(await insertCategory());
    const id = rows[0].id as string;
    assert.equal(rows[0].version, 1);
    // A raw write that "forgets" both columns, like a future stock movement could.
    await db.pool.query(`UPDATE products SET quantity = 7, updated_at = '2000-01-01' WHERE id = $1`, [id]);
    const after = await db.pool.query<{ version: number; updated_at: Date }>(
      'SELECT version, updated_at FROM products WHERE id = $1',
      [id],
    );
    assert.equal(after.rows[0]?.version, 2);
    assert.ok(after.rows[0]!.updated_at.getUTCFullYear() > 2000);
    // Setting version by hand cannot move it backwards either.
    await db.pool.query('UPDATE products SET version = 1 WHERE id = $1', [id]);
    assert.equal((await db.pool.query('SELECT version FROM products WHERE id = $1', [id])).rows[0].version, 3);
  });

  test('category and user updates refresh updated_at', async () => {
    const categoryId = await insertCategory();
    const userId = await insertUser();
    await db.pool.query(`UPDATE categories SET updated_at = '2000-01-01' WHERE id = $1`, [categoryId]);
    await db.pool.query(`UPDATE users SET updated_at = '2000-01-01' WHERE id = $1`, [userId]);
    const category = await db.pool.query<{ updated_at: Date }>('SELECT updated_at FROM categories WHERE id = $1', [categoryId]);
    const user = await db.pool.query<{ updated_at: Date }>('SELECT updated_at FROM users WHERE id = $1', [userId]);
    assert.ok(category.rows[0]!.updated_at.getUTCFullYear() > 2000);
    assert.ok(user.rows[0]!.updated_at.getUTCFullYear() > 2000);
  });

  test('a category with products cannot be deleted', async () => {
    const categoryId = await insertCategory();
    await insertProduct(categoryId);
    assert.equal(
      await constraintOf(db.pool.query('DELETE FROM categories WHERE id = $1', [categoryId])),
      'products_category_id_fkey',
    );
  });

  test('deleting a user or product keeps the movement history with snapshots', async () => {
    const userId = await insertUser();
    const { rows } = await insertProduct(await insertCategory());
    const productId = rows[0].id as string;
    const movementId = '11111111-1111-4111-8111-111111111111';
    await db.pool.query(
      `INSERT INTO stock_movements (id, type, user_id, user_full_name) VALUES ($1, 'sale', $2, 'Test User')`,
      [movementId, userId],
    );
    await db.pool.query(
      `INSERT INTO stock_movement_items (movement_id, line_no, product_id, product_name, product_brand, unit_price, delta, quantity_after)
       VALUES ($1, 1, $2, 'Milk', 'Brand', '10.00', -1, 0)`,
      [movementId, productId],
    );
    await db.pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await db.pool.query('DELETE FROM products WHERE id = $1', [productId]);
    const movement = await db.pool.query('SELECT user_id, user_full_name FROM stock_movements');
    assert.deepEqual(movement.rows, [{ user_id: null, user_full_name: 'Test User' }]);
    const item = await db.pool.query('SELECT product_id, product_name FROM stock_movement_items');
    assert.deepEqual(item.rows, [{ product_id: null, product_name: 'Milk' }]);
  });

  test('enforces the movement constraints', async () => {
    const movementId = '22222222-2222-4222-8222-222222222222';
    const insert = (type: string, id: string) =>
      db.pool.query(`INSERT INTO stock_movements (id, type, user_full_name) VALUES ($1, $2, 'X')`, [id, type]);
    assert.equal(await constraintOf(insert('gift', movementId)), 'stock_movements_type_valid');
    await insert('sale', movementId);
    const item = (delta: number, lineNo = 1) =>
      db.pool.query(
        `INSERT INTO stock_movement_items (movement_id, line_no, product_name, product_brand, unit_price, delta, quantity_after)
         VALUES ($1, $2, 'Milk', 'Brand', '1.00', $3, 0)`,
        [movementId, lineNo, delta],
      );
    assert.equal(await constraintOf(item(0)), 'stock_movement_items_delta_non_zero');
    assert.equal(await constraintOf(item(1, 51)), 'stock_movement_items_line_no_range');
  });

  test('deleting a user removes their sessions', async () => {
    const userId = await insertUser();
    await db.pool.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (decode(repeat('ab', 32), 'hex'), $1, now() + interval '1 hour')`,
      [userId],
    );
    await db.pool.query('DELETE FROM users WHERE id = $1', [userId]);
    assert.equal((await db.pool.query('SELECT 1 FROM sessions')).rowCount, 0);
  });
});
