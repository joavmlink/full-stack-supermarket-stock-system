import type pg from 'pg';
import { z } from 'zod';
import { withTransaction, type Queryable } from '../db/pool.js';
import { MAX_QUANTITY } from '../db/schema.js';
import { AppError, alreadyExists, notFound, unauthenticated, type ErrorDetail } from '../errors.js';
import type { Page } from '../lib/pagination.js';
import { isForeignKeyViolation } from '../lib/pg-errors.js';
import type { Created } from '../lib/routing.js';
import { validationError } from '../lib/validation.js';
import {
  MovementTypeSchema,
  type MovementType,
  type StockMovement,
  type StockMovementCreate,
  type StockMovementListQuery,
} from '../schemas/movement-schemas.js';
import type { User } from '../schemas/user-schemas.js';
import { listPage } from './keyset.js';

/** Who records a movement; the name is stored as a snapshot. */
export type Actor = Pick<User, 'id' | 'fullName'>;

export interface MovementItemInput {
  productId: string;
  productName: string;
  productBrand: string;
  unitPrice: string;
  delta: number;
  quantityAfter: number;
}

const ClaimRow = z.object({ created_at: z.date() });

/**
 * The first write of every movement transaction: inserts the movement row and
 * returns its created_at, or null when the id is taken. Under READ COMMITTED a
 * concurrent insert of the same id makes this wait: if that one commits, the
 * claim returns null (a retry of an attempt that landed); if it rolls back,
 * the claim goes ahead. So one statement settles every duplicate, raced or not.
 */
async function claimMovementId(
  client: pg.PoolClient,
  movement: { id: string; type: MovementType; actor: Actor },
): Promise<Date | null> {
  const { rows } = await client
    .query(
      `INSERT INTO stock_movements (id, type, user_id, user_full_name) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING
       RETURNING created_at`,
      [movement.id, movement.type, movement.actor.id, movement.actor.fullName],
    )
    .catch((error: unknown) => {
      // The author was deleted while the request was in flight: their session is gone too.
      throw isForeignKeyViolation(error, 'stock_movements_user_id_fkey') ? unauthenticated() : error;
    });
  return rows[0] === undefined ? null : ClaimRow.parse(rows[0]).created_at;
}

async function insertMovementLines(client: pg.PoolClient, movementId: string, items: MovementItemInput[]) {
  await client.query(
    `INSERT INTO stock_movement_items
       (movement_id, line_no, product_id, product_name, product_brand, unit_price, delta, quantity_after)
     SELECT $1, i.line_no, i.product_id, i.product_name, i.product_brand, i.unit_price, i.delta, i.quantity_after
     FROM unnest($2::int[], $3::uuid[], $4::text[], $5::text[], $6::numeric[], $7::int[], $8::int[])
       AS i(line_no, product_id, product_name, product_brand, unit_price, delta, quantity_after)`,
    [
      movementId,
      items.map((_, index) => index + 1),
      items.map((item) => item.productId),
      items.map((item) => item.productName),
      items.map((item) => item.productBrand),
      items.map((item) => item.unitPrice),
      items.map((item) => item.delta),
      items.map((item) => item.quantityAfter),
    ],
  );
}

/**
 * Records a stock movement and its lines. Must run inside the transaction that
 * changed the quantities, so the history always matches the stock. Product
 * name, brand, price and the author's name are snapshots: they survive later
 * edits and deletions.
 */
export async function insertMovement(
  client: pg.PoolClient,
  movement: { id: string; type: MovementType; actor: Actor; items: MovementItemInput[] },
): Promise<void> {
  if ((await claimMovementId(client, movement)) === null) throw alreadyExists();
  await insertMovementLines(client, movement.id, movement.items);
}

/**
 * Movements (aliased `t`) with their lines in line order. The price is cast to
 * text inside the JSON: a numeric in json_build_object becomes a JSON number,
 * which would lose precision in JavaScript.
 */
const SELECT_MOVEMENTS = `SELECT t.id, t.type, t.user_id, t.user_full_name, t.created_at, lines.items
  FROM stock_movements t
  CROSS JOIN LATERAL (
    SELECT json_agg(json_build_object(
             'productId', i.product_id,
             'productName', i.product_name,
             'productBrand', i.product_brand,
             'unitPrice', i.unit_price::text,
             'delta', i.delta,
             'quantityAfter', i.quantity_after
           ) ORDER BY i.line_no) AS items
    FROM stock_movement_items i
    WHERE i.movement_id = t.id
  ) lines`;

const MovementRow = z.object({
  id: z.uuid(),
  type: MovementTypeSchema,
  user_id: z.uuid().nullable(),
  user_full_name: z.string(),
  created_at: z.date(),
  items: z.array(
    z.object({
      productId: z.uuid().nullable(),
      productName: z.string(),
      productBrand: z.string(),
      unitPrice: z.string(),
      delta: z.number().int(),
      quantityAfter: z.number().int(),
    }),
  ),
});

/** A stored line, or one just written (whose product still exists), in its API form. */
function toItem(item: Omit<MovementItemInput, 'productId'> & { productId: string | null }): StockMovement['items'][number] {
  return {
    product: { id: item.productId, name: item.productName, brand: item.productBrand },
    unitPrice: item.unitPrice,
    delta: item.delta,
    quantityAfter: item.quantityAfter,
  };
}

function toMovement(row: unknown): StockMovement {
  const value = MovementRow.parse(row);
  return {
    id: value.id,
    type: value.type,
    user: { id: value.user_id, fullName: value.user_full_name },
    items: value.items.map(toItem),
    createdAt: value.created_at.toISOString(),
  };
}

/** Admins see every movement; an employee sees only their own (anyone else's does not exist for them). */
export const ownerFilter = (viewer: User) => (viewer.role === 'admin' ? null : viewer.id);

export function listStockMovements(
  db: Queryable,
  query: StockMovementListQuery,
  viewer: User,
): Promise<Page<StockMovement>> {
  const params: unknown[] = [];
  const param = (value: unknown) => `$${params.push(value)}`;
  const owner = ownerFilter(viewer);
  const scope = owner === null ? [] : [`t.user_id = ${param(owner)}`];
  const where = query.type === undefined ? [] : [`t.type = ${param(query.type)}`];
  return listPage(db, {
    table: 'stock_movements',
    from: SELECT_MOVEMENTS,
    scope,
    where,
    params,
    query,
    resource: 'stock movement',
    toItem: toMovement,
  });
}

export async function getStockMovement(db: Queryable, id: string, viewer: User): Promise<StockMovement> {
  const { rows } = await db.query(`${SELECT_MOVEMENTS} WHERE t.id = $1 AND ($2::uuid IS NULL OR t.user_id = $2)`, [
    id,
    ownerFilter(viewer),
  ]);
  if (rows[0] === undefined) throw notFound('STOCK_MOVEMENT', 'Stock movement');
  return toMovement(rows[0]);
}

const LockedProductRow = z.object({
  id: z.uuid(),
  brand: z.string(),
  name: z.string(),
  price: z.string(),
  quantity: z.number().int(),
});

/** A sale takes units out of stock; a restock adds them. */
const signOf = (type: StockMovementCreate['type']) => (type === 'sale' ? -1 : 1);

/** Whether a stored movement is the same form: same author, type and lines in the same order. */
function sameForm(stored: StockMovement, input: StockMovementCreate, actor: Actor): boolean {
  const sign = signOf(input.type);
  return (
    stored.user.id === actor.id &&
    stored.type === input.type &&
    stored.items.length === input.items.length &&
    stored.items.every(
      (item, index) =>
        item.product.id === input.items[index]?.productId && item.delta === sign * (input.items[index]?.quantity ?? 0),
    )
  );
}

/**
 * Applies the stock form all or nothing.
 *
 * The id is claimed first (`claimMovementId`), so a taken id is settled before
 * the stock is judged, even when a retry races the attempt that landed: the
 * same form from the same author returns the stored movement (a replay), and
 * anything else answers 409 ALREADY_EXISTS. Then the products are locked in id
 * order (`ORDER BY id FOR UPDATE`), so two forms that share products always
 * lock them in the same order and cannot deadlock. Every failing line is
 * reported, not just the first.
 */
export async function createStockMovement(
  pool: pg.Pool,
  input: StockMovementCreate,
  actor: Actor,
): Promise<Created<StockMovement>> {
  return withTransaction(pool, async (client) => {
    const createdAt = await claimMovementId(client, { id: input.id, type: input.type, actor });
    if (createdAt === null) {
      const { rows } = await client.query(`${SELECT_MOVEMENTS} WHERE t.id = $1`, [input.id]);
      const stored = rows[0] === undefined ? null : toMovement(rows[0]);
      if (stored === null || !sameForm(stored, input, actor)) throw alreadyExists();
      return { item: stored, created: false };
    }
    const locked = await client.query(
      'SELECT id, brand, name, price, quantity FROM products WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [input.items.map((item) => item.productId)],
    );
    const products = new Map(locked.rows.map((row) => LockedProductRow.parse(row)).map((row) => [row.id, row]));

    const sign = signOf(input.type);
    const lines: MovementItemInput[] = [];
    const missing: ErrorDetail[] = [];
    const failures: ErrorDetail[] = [];
    input.items.forEach((item, index) => {
      const product = products.get(item.productId);
      if (product === undefined) {
        missing.push({ path: `items.${index}.productId`, message: 'does not match any product' });
        return;
      }
      const delta = sign * item.quantity;
      const quantityAfter = product.quantity + delta;
      const detail = {
        path: `items.${index}.quantity`,
        productId: product.id,
        requested: item.quantity,
        available: product.quantity,
      };
      if (quantityAfter < 0) {
        failures.push({ ...detail, message: `only ${product.quantity} in stock` });
      } else if (quantityAfter > MAX_QUANTITY) {
        failures.push({
          ...detail,
          message: `the stock cannot exceed ${MAX_QUANTITY}; ${product.quantity} in stock`,
          max: MAX_QUANTITY,
        });
      }
      lines.push({
        productId: product.id,
        productName: product.name,
        productBrand: product.brand,
        unitPrice: product.price,
        delta,
        quantityAfter,
      });
    });
    if (missing.length > 0) throw validationError('Invalid request body.', missing);
    if (failures.length > 0) {
      throw input.type === 'sale'
        ? new AppError(409, 'INSUFFICIENT_STOCK', 'There is not enough stock for some products.', { details: failures })
        : new AppError(409, 'STOCK_LIMIT_EXCEEDED', 'This restock would exceed the stock limit.', { details: failures });
    }

    // The rows are locked, so the quantities read above are still the current ones.
    await client.query(
      `UPDATE products p SET quantity = p.quantity + d.delta
       FROM unnest($1::uuid[], $2::int[]) AS d(id, delta)
       WHERE p.id = d.id`,
      [lines.map((line) => line.productId), lines.map((line) => line.delta)],
    );
    await insertMovementLines(client, input.id, lines);
    return {
      item: {
        id: input.id,
        type: input.type,
        user: { id: actor.id, fullName: actor.fullName },
        items: lines.map(toItem),
        createdAt: createdAt.toISOString(),
      },
      created: true,
    };
  });
}
