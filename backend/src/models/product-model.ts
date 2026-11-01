import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction, type Queryable } from '../db/pool.js';
import { AppError, alreadyExists, notFound } from '../errors.js';
import type { Page } from '../lib/pagination.js';
import type { Created } from '../lib/routing.js';
import { isForeignKeyViolation } from '../lib/pg-errors.js';
import { validationError } from '../lib/validation.js';
import type { Product, ProductCreate, ProductListQuery, ProductUpdate } from '../schemas/product-schemas.js';
import { listPage } from './keyset.js';
import { insertMovement, type Actor } from './movement-model.js';
import { timestampColumns, timestampsOf } from './rows.js';

/** Products (aliased `t`) read from `source` (the table, or a CTE of written rows) with their category. */
const selectProducts = (source: string) => `SELECT t.id, t.brand, t.name, t.description, t.quantity, t.price,
    t.version, t.created_at, t.updated_at, c.id AS category_id, c.name AS category_name
  FROM ${source} t JOIN categories c ON c.id = t.category_id`;

const ProductRow = z.object({
  id: z.uuid(),
  brand: z.string(),
  name: z.string(),
  description: z.string(),
  quantity: z.number().int(),
  price: z.string(),
  version: z.number().int(),
  ...timestampColumns,
  category_id: z.uuid(),
  category_name: z.string(),
});

function toProduct(row: unknown): Product {
  const value = ProductRow.parse(row);
  return {
    id: value.id,
    category: { id: value.category_id, name: value.category_name },
    brand: value.brand,
    name: value.name,
    description: value.description,
    quantity: value.quantity,
    price: value.price,
    version: value.version,
    ...timestampsOf(value),
  };
}

const productNotFound = () => notFound('PRODUCT', 'Product');

/** The editable values of a product, as a create or an edit sends them. */
type ProductValues = Omit<ProductCreate, 'id'>;

/** Whether `product` already holds every value in `values` (a write that was already applied). */
function holds(product: Product, values: Partial<ProductValues>): boolean {
  const current: ProductValues = {
    categoryId: product.category.id,
    brand: product.brand,
    name: product.name,
    description: product.description,
    quantity: product.quantity,
    price: product.price,
  };
  return (Object.keys(values) as (keyof ProductValues)[]).every(
    (key) => values[key] === undefined || values[key] === current[key],
  );
}

/** `%`, `_` and `\` are literal in a search, not LIKE wildcards. */
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

export function listProducts(db: Queryable, query: ProductListQuery): Promise<Page<Product>> {
  const where: string[] = [];
  const params: unknown[] = [];
  const param = (value: unknown) => `$${params.push(value)}`;
  if (query.q !== undefined) {
    const pattern = param(likePattern(query.q));
    where.push(`(t.name ILIKE ${pattern} ESCAPE '\\' OR t.brand ILIKE ${pattern} ESCAPE '\\')`);
  }
  if (query.categoryId !== undefined) where.push(`t.category_id = ${param(query.categoryId)}`);
  return listPage(db, {
    table: 'products',
    from: selectProducts('products'),
    where,
    params,
    query,
    resource: 'product',
    toItem: toProduct,
  });
}

/** The product, or null; `lock` keeps its row locked until the transaction ends. */
async function findProduct(db: Queryable, id: string, { lock = false } = {}): Promise<Product | null> {
  const { rows } = await db.query(`${selectProducts('products')} WHERE t.id = $1${lock ? ' FOR UPDATE OF t' : ''}`, [id]);
  return rows[0] === undefined ? null : toProduct(rows[0]);
}

export async function getProduct(db: Queryable, id: string): Promise<Product> {
  const product = await findProduct(db, id);
  if (product === null) throw productNotFound();
  return product;
}

/** Records a stock change made outside the stock form (initial stock, an edit, a deletion) as an adjustment. */
async function recordAdjustment(client: pg.PoolClient, product: Product, delta: number, actor: Actor) {
  await insertMovement(client, {
    id: randomUUID(),
    type: 'adjustment',
    actor,
    items: [
      {
        productId: product.id,
        productName: product.name,
        productBrand: product.brand,
        unitPrice: product.price,
        delta,
        quantityAfter: product.quantity,
      },
    ],
  });
}

function rethrowInvalidCategory(error: unknown): never {
  throw isForeignKeyViolation(error, 'products_category_id_fkey')
    ? validationError('Invalid request body.', [{ path: 'categoryId', message: 'does not match any category' }])
    : error;
}

/**
 * Creates a product; initial stock above zero is recorded as an adjustment in
 * the same transaction. A taken id whose stored product still holds the same
 * values is a replayed create: the stored product comes back, and nothing is recorded twice.
 */
export async function createProduct(pool: pg.Pool, input: ProductCreate, actor: Actor): Promise<Created<Product>> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `WITH created AS (
         INSERT INTO products (id, category_id, brand, name, description, quantity, price)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING
         RETURNING *
       )
       ${selectProducts('created')}`,
      [input.id, input.categoryId, input.brand, input.name, input.description, input.quantity, input.price],
    );
    if (rows[0] === undefined) {
      const stored = await findProduct(client, input.id);
      const { id: _id, ...values } = input;
      if (stored === null || !holds(stored, values)) throw alreadyExists();
      return { item: stored, created: false };
    }
    const product = toProduct(rows[0]);
    if (product.quantity > 0) await recordAdjustment(client, product, product.quantity, actor);
    return { item: product, created: true };
  }).catch(rethrowInvalidCategory);
}

/**
 * Optimistic locking: the update applies only if `version` still matches (a
 * trigger bumps it on every write). A stale version whose product already
 * holds every requested value (a retry of an edit that landed) returns the
 * product unchanged. A quantity change is recorded as an adjustment in the
 * same transaction, so the movement history always explains the stock.
 */
export async function updateProduct(pool: pg.Pool, id: string, changes: ProductUpdate, actor: Actor): Promise<Product> {
  return withTransaction(pool, async (client) => {
    const current = await findProduct(client, id, { lock: true });
    if (current === null) throw productNotFound();
    if (current.version !== changes.version) {
      const { version: _version, ...values } = changes;
      if (holds(current, values)) return current;
      throw new AppError(409, 'PRODUCT_VERSION_CONFLICT', 'Someone else changed this product. Reload it and try again.', {
        details: [{ path: 'version', message: `the current version is ${current.version}`, currentVersion: current.version }],
      });
    }
    const { rows } = await client.query(
      `WITH updated AS (
         UPDATE products SET
           category_id = COALESCE($2, category_id),
           brand = COALESCE($3, brand),
           name = COALESCE($4, name),
           description = COALESCE($5, description),
           quantity = COALESCE($6, quantity),
           price = COALESCE($7, price)
         WHERE id = $1
         RETURNING *
       )
       ${selectProducts('updated')}`,
      [
        id,
        changes.categoryId ?? null,
        changes.brand ?? null,
        changes.name ?? null,
        changes.description ?? null,
        changes.quantity ?? null,
        changes.price ?? null,
      ],
    );
    const product = toProduct(rows[0]);
    const delta = product.quantity - current.quantity;
    if (delta !== 0) await recordAdjustment(client, product, delta, actor);
    return product;
  }).catch(rethrowInvalidCategory);
}

/**
 * Deletes a product. Stock it still holds leaves as an adjustment first, so the
 * history keeps explaining the stock; the movement lines keep name, brand and
 * price snapshots after the product is gone.
 */
export async function deleteProduct(pool: pg.Pool, id: string, actor: Actor): Promise<void> {
  await withTransaction(pool, async (client) => {
    const product = await findProduct(client, id, { lock: true });
    if (product === null) throw productNotFound();
    if (product.quantity > 0) await recordAdjustment(client, { ...product, quantity: 0 }, -product.quantity, actor);
    await client.query('DELETE FROM products WHERE id = $1', [id]);
  });
}
