import { createHash } from 'node:crypto';
import type pg from 'pg';
import { isUndefinedTable } from '../lib/pg-errors.js';
import { withTransaction } from './pool.js';

/** Arbitrary constant that identifies the schema migration lock. */
const SCHEMA_LOCK_KEY = 4_815_162_342;

export const MAX_QUANTITY = 1_000_000;
export const MAX_ITEMS_PER_MOVEMENT = 50;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name text NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_full_name_length CHECK (char_length(full_name) BETWEEN 1 AND 100),
    CONSTRAINT users_email_length CHECK (char_length(email) BETWEEN 3 AND 254),
    CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
    CONSTRAINT users_role_valid CHECK (role IN ('admin', 'employee'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email)`,
  `CREATE INDEX IF NOT EXISTS users_role_created_idx ON users (role, created_at DESC, id DESC)`,

  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash bytea PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CONSTRAINT sessions_token_hash_length CHECK (octet_length(token_hash) = 32)
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id)`,
  `CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at)`,

  `CREATE TABLE IF NOT EXISTS categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT categories_name_length CHECK (char_length(name) BETWEEN 1 AND 60)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS categories_name_key ON categories (lower(name))`,
  `CREATE INDEX IF NOT EXISTS categories_created_idx ON categories (created_at DESC, id DESC)`,

  `CREATE TABLE IF NOT EXISTS products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id uuid NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
    brand text NOT NULL,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    quantity integer NOT NULL,
    price numeric(10, 2) NOT NULL,
    version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT products_brand_length CHECK (char_length(brand) BETWEEN 1 AND 60),
    CONSTRAINT products_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT products_description_length CHECK (char_length(description) <= 1000),
    CONSTRAINT products_quantity_range CHECK (quantity BETWEEN 0 AND ${MAX_QUANTITY}),
    CONSTRAINT products_price_non_negative CHECK (price >= 0),
    CONSTRAINT products_version_positive CHECK (version >= 1)
  )`,
  `CREATE INDEX IF NOT EXISTS products_created_idx ON products (created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS products_category_created_idx ON products (category_id, created_at DESC, id DESC)`,

  `CREATE TABLE IF NOT EXISTS stock_movements (
    id uuid PRIMARY KEY,
    type text NOT NULL,
    user_id uuid REFERENCES users (id) ON DELETE SET NULL,
    user_full_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT stock_movements_type_valid CHECK (type IN ('sale', 'restock', 'adjustment'))
  )`,
  `CREATE INDEX IF NOT EXISTS stock_movements_created_idx ON stock_movements (created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS stock_movements_user_created_idx ON stock_movements (user_id, created_at DESC, id DESC)`,

  `CREATE TABLE IF NOT EXISTS stock_movement_items (
    movement_id uuid NOT NULL REFERENCES stock_movements (id) ON DELETE CASCADE,
    line_no integer NOT NULL,
    product_id uuid REFERENCES products (id) ON DELETE SET NULL,
    product_name text NOT NULL,
    product_brand text NOT NULL,
    unit_price numeric(10, 2) NOT NULL,
    delta integer NOT NULL,
    quantity_after integer NOT NULL,
    PRIMARY KEY (movement_id, line_no),
    CONSTRAINT stock_movement_items_line_no_range CHECK (line_no BETWEEN 1 AND ${MAX_ITEMS_PER_MOVEMENT}),
    CONSTRAINT stock_movement_items_delta_non_zero CHECK (delta <> 0),
    CONSTRAINT stock_movement_items_quantity_after_range CHECK (quantity_after BETWEEN 0 AND ${MAX_QUANTITY}),
    CONSTRAINT stock_movement_items_unit_price_non_negative CHECK (unit_price >= 0)
  )`,
  `CREATE INDEX IF NOT EXISTS stock_movement_items_product_idx ON stock_movement_items (product_id)`,

  `CREATE TABLE IF NOT EXISTS rate_limits (
    key text PRIMARY KEY,
    hits integer NOT NULL,
    reset_at timestamptz NOT NULL,
    CONSTRAINT rate_limits_hits_non_negative CHECK (hits >= 0)
  )`,
  `CREATE INDEX IF NOT EXISTS rate_limits_reset_at_idx ON rate_limits (reset_at)`,

  `CREATE TABLE IF NOT EXISTS schema_version (
    id boolean PRIMARY KEY DEFAULT true,
    hash text NOT NULL,
    CONSTRAINT schema_version_one_row CHECK (id)
  )`,

  // Bookkeeping enforced by the database, so no write path can forget it.
  `CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     NEW.updated_at := now();
     RETURN NEW;
   END
   $$`,
  // Optimistic locking: every product write (an admin edit or a stock movement)
  // bumps version, so an edit based on stale data can never overwrite a sale.
  `CREATE OR REPLACE FUNCTION bump_product_version() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     NEW.version := OLD.version + 1;
     NEW.updated_at := now();
     RETURN NEW;
   END
   $$`,
  `CREATE OR REPLACE TRIGGER products_bump_version BEFORE UPDATE ON products
     FOR EACH ROW EXECUTE FUNCTION bump_product_version()`,
  `CREATE OR REPLACE TRIGGER categories_touch_updated_at BEFORE UPDATE ON categories
     FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,
  `CREATE OR REPLACE TRIGGER users_touch_updated_at BEFORE UPDATE ON users
     FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,
];

/** Identifies these statements, so changing any of them makes the next start run them. */
const SCHEMA_HASH = createHash('sha256').update(STATEMENTS.join('\n')).digest('hex');

/** Table names in an order that is safe for TRUNCATE ... CASCADE in tests (the version stays). */
export const TABLES = [
  'stock_movement_items',
  'stock_movements',
  'products',
  'categories',
  'sessions',
  'users',
  'rate_limits',
] as const;

async function isSchemaCurrent(pool: pg.Pool): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ hash: string }>('SELECT hash FROM schema_version');
    return rows[0]?.hash === SCHEMA_HASH;
  } catch (error) {
    if (isUndefinedTable(error)) return false;
    throw error;
  }
}

/**
 * Creates the schema idempotently, only when these statements have not run yet:
 * they lock every table until they commit, which a new instance must not do to
 * the writes in progress. A current schema costs one read and takes no locks.
 * The transaction-scoped advisory lock makes a second instance wait instead of
 * racing the first one on CREATE statements.
 */
export async function ensureSchema(pool: pg.Pool): Promise<void> {
  if (await isSchemaCurrent(pool)) return;
  await withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);
    for (const statement of STATEMENTS) {
      await client.query(statement);
    }
    await client.query(
      `INSERT INTO schema_version (id, hash) VALUES (true, $1)
       ON CONFLICT (id) DO UPDATE SET hash = EXCLUDED.hash`,
      [SCHEMA_HASH],
    );
  });
}
